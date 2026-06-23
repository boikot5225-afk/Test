// Sequential reader playback. It is isolated from readerAI, word saving and language UI.
(function () {
  'use strict';

  let playbackToken = 0;
  let audioContext = null;
  let currentSource = null;
  let isPlaying = false;
  let activeParagraph = -1;

  function toast(message, ms) {
    try { window.showToast?.(message, ms); } catch (_) {}
  }

  function readerRoot() {
    return document.getElementById('screen-reader') || document.getElementById('reader-reading-view') || document.body;
  }

  function chapterRoot() {
    return document.getElementById('reader-chapter-text');
  }

  function getLang() {
    const view = document.getElementById('reader-reading-view');
    const value = view?.dataset?.readerLang || document.documentElement?.dataset?.readerLang || globalThis.AN2_LANG || 'fr';
    return String(value).toLowerCase().startsWith('zh') ? 'zh' : 'fr';
  }

  function getRate(lang) {
    return lang === 'zh' ? 0.92 : 0.9;
  }

  function getContext() {
    if (!audioContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) throw new Error('Этот браузер не поддерживает аудио.');
      audioContext = new AudioCtor();
    }
    return audioContext;
  }

  async function getFirebaseUser() {
    const auth = globalThis.firebase?.auth?.();
    if (!auth) throw new Error('Firebase ещё не готов. Перезагрузи приложение и войди снова.');
    if (auth.currentUser) return auth.currentUser;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Не удалось дождаться входа в аккаунт.')), 7000);
      const off = auth.onAuthStateChanged((user) => {
        if (!user) return;
        clearTimeout(timer);
        try { off?.(); } catch (_) {}
        resolve(user);
      });
    });
  }

  async function fetchAudio(text, lang) {
    const user = await getFirebaseUser();
    const token = await user.getIdToken(false);
    const projectId = String(globalThis.FIREBASE_CONFIG?.projectId || 'french-da79a').trim();
    const region = String(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1').trim();
    const url = `https://${region}-${projectId}.cloudfunctions.net/ttsAudio`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, lang, speed: getRate(lang) })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Озвучка вернула ${response.status}${detail ? ': ' + detail.slice(0, 120) : ''}`);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength < 200) throw new Error('Озвучка вернула пустое аудио.');
    return buffer;
  }

  function paragraphs() {
    const root = chapterRoot();
    if (!root) return [];
    return [...root.querySelectorAll('.reader-paragraph')]
      .map((el) => ({ el, index: Number(el.dataset.p), text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter((item) => Number.isFinite(item.index) && item.text);
  }

  function getStartIndex() {
    const active = chapterRoot()?.querySelector('.reader-paragraph.active');
    const index = Number(active?.dataset?.p);
    return Number.isFinite(index) ? index : 0;
  }

  function setControls(state) {
    const start = document.getElementById('an2-reader-audio-start');
    const stop = document.getElementById('an2-reader-audio-stop');
    const label = document.getElementById('an2-reader-audio-status');
    if (start) start.disabled = state === 'playing';
    if (stop) stop.style.display = state === 'playing' ? '' : 'none';
    if (label) label.textContent = state === 'playing'
      ? `🎧 Слушаю абзац ${activeParagraph + 1}`
      : state === 'done' ? '✓ Озвучка остановлена на текущем месте' : 'Слушать с текущего места';
  }

  function ensureControls() {
    const root = chapterRoot();
    if (!root) return;
    const existing = document.getElementById('an2-reader-audio-bar');
    if (existing && existing.parentElement === root.parentElement) return;
    existing?.remove();
    const bar = document.createElement('div');
    bar.id = 'an2-reader-audio-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 14px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface2);';
    bar.innerHTML = '<button id="an2-reader-audio-start" type="button" class="btn btn-primary" style="padding:8px 12px;font-size:.82rem">🎧 Слушать с текущего места</button><button id="an2-reader-audio-stop" type="button" class="btn btn-secondary" style="display:none;padding:8px 12px;font-size:.82rem">⏹ Стоп</button><span id="an2-reader-audio-status" style="font-size:.76rem;color:var(--text-muted)">Слушать с текущего места</span>';
    root.parentElement.insertBefore(bar, root);
    bar.querySelector('#an2-reader-audio-start')?.addEventListener('click', () => startFromCurrent());
    bar.querySelector('#an2-reader-audio-stop')?.addEventListener('click', () => stop());
  }

  function markParagraph(index) {
    const item = paragraphs().find((p) => p.index === index);
    if (!item) return;
    item.el.classList.add('active');
    item.el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }

  function moveReaderPosition(index) {
    const item = paragraphs().find((p) => p.index === index);
    if (!item) return false;
    try { item.el.click(); } catch (_) {}
    return true;
  }

  async function playNext(index, token) {
    if (!isPlaying || token !== playbackToken) return;
    const item = paragraphs().find((p) => p.index === index);
    if (!item) {
      finish();
      toast('🎧 Глава закончилась');
      return;
    }

    activeParagraph = index;
    markParagraph(index);
    setControls('playing');

    try {
      const ctx = getContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const raw = await fetchAudio(item.text, getLang());
      if (!isPlaying || token !== playbackToken) return;
      const decoded = await ctx.decodeAudioData(raw.slice(0));
      if (!isPlaying || token !== playbackToken) return;
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      currentSource = source;
      source.onended = () => {
        if (!isPlaying || token !== playbackToken || currentSource !== source) return;
        currentSource = null;
        moveReaderPosition(index + 1);
        setTimeout(() => playNext(index + 1, token), 80);
      };
      source.start(0);
    } catch (error) {
      if (token !== playbackToken) return;
      finish();
      toast('⚠️ Озвучка остановилась: ' + String(error?.message || error).slice(0, 170), 6500);
    }
  }

  function startFromCurrent() {
    const list = paragraphs();
    if (!list.length) { toast('Сначала открой книгу или главу.'); return; }
    stop(false);
    isPlaying = true;
    playbackToken += 1;
    const token = playbackToken;
    const start = getStartIndex();
    activeParagraph = start;
    setControls('playing');
    playNext(start, token);
  }

  function finish() {
    isPlaying = false;
    currentSource = null;
    setControls('done');
  }

  function stop(show = true) {
    playbackToken += 1;
    isPlaying = false;
    if (currentSource) {
      try { currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
    setControls('done');
    if (show) toast('⏹ Озвучка остановлена');
  }

  function installLibraryButtons() {
    const library = document.getElementById('reader-library-list');
    if (!library || library.dataset.bookAudioBound === '1') return;
    library.dataset.bookAudioBound = '1';
    const bind = () => {
      library.querySelectorAll('.lib-book-actions .lib-action-btn, .lib-news-card .lib-action-btn').forEach((button) => {
        if (button.dataset.bookAudioBound === '1' || button.textContent.trim() !== '🔊') return;
        button.dataset.bookAudioBound = '1';
        button.title = 'Открыть книгу и слушать с текущего места';
        button.onclick = (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          const card = button.closest('.lib-book-card, .lib-news-card');
          const open = card?.querySelector('.lib-book-main, .lib-news-main');
          open?.click?.();
          setTimeout(startFromCurrent, 650);
          return false;
        };
      });
    };
    bind();
    new MutationObserver(bind).observe(library, { childList: true, subtree: true });
  }

  function install() {
    const scan = () => {
      ensureControls();
      installLibraryButtons();
    };
    scan();
    setInterval(scan, 1200);
  }

  window.an2ReaderStartBookAudio = startFromCurrent;
  window.an2ReaderStopBookAudio = stop;
  install();
})();

// Sequential reader playback.
// This module replaces only the existing pinned “🔊 Слушать” button in the reader.
// It does not touch readerAI, DeepSeek, word saving, verbs, or language switching.
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

  function chapterRoot() {
    return document.getElementById('reader-chapter-text');
  }

  function listenButton() {
    return document.getElementById('reader-listen-btn');
  }

  function detectLang() {
    const text = String(chapterRoot()?.textContent || '');
    if (/[㐀-鿿]/.test(text)) return 'zh';
    return 'fr';
  }

  function rateFor(lang) {
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

  async function firebaseUser() {
    const auth = globalThis.firebase?.auth?.();
    if (!auth) throw new Error('Firebase ещё не готов. Перезагрузи приложение и войди снова.');
    if (auth.currentUser) return auth.currentUser;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Не удалось дождаться входа в аккаунт.')), 7000);
      const unsubscribe = auth.onAuthStateChanged((user) => {
        if (!user) return;
        clearTimeout(timer);
        try { unsubscribe?.(); } catch (_) {}
        resolve(user);
      });
    });
  }

  async function requestAudio(text, lang) {
    const user = await firebaseUser();
    const idToken = await user.getIdToken(false);
    const projectId = String(globalThis.FIREBASE_CONFIG?.projectId || 'french-da79a').trim();
    const region = String(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1').trim();
    const response = await fetch(`https://${region}-${projectId}.cloudfunctions.net/ttsAudio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ text, lang, speed: rateFor(lang) })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Озвучка вернула ${response.status}${detail ? ': ' + detail.slice(0, 120) : ''}`);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength < 200) throw new Error('Озвучка вернула пустое аудио.');
    return buffer;
  }

  function allParagraphs() {
    const root = chapterRoot();
    if (!root) return [];
    return [...root.querySelectorAll('.reader-paragraph')]
      .map((el) => ({
        el,
        index: Number(el.dataset.p),
        text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter((item) => Number.isFinite(item.index) && item.text);
  }

  function selectedIndex() {
    const active = chapterRoot()?.querySelector('.reader-paragraph.active');
    const index = Number(active?.dataset?.p);
    return Number.isFinite(index) ? index : 0;
  }

  function setButtonState(state) {
    const button = listenButton();
    if (!button) return;
    if (state === 'playing') {
      button.textContent = `⏹ Стоп · ${activeParagraph + 1}`;
      button.title = 'Остановить озвучку';
      button.setAttribute('aria-label', 'Остановить озвучку');
      button.classList.add('is-playing');
    } else {
      button.textContent = '🔊 Слушать';
      button.title = state === 'done' ? 'Продолжить с текущего абзаца' : 'Слушать с текущего места';
      button.setAttribute('aria-label', 'Слушать с текущего места');
      button.classList.remove('is-playing');
    }
  }

  function updateReaderPosition(index) {
    const item = allParagraphs().find((p) => p.index === index);
    if (!item) return false;
    try { item.el.click(); } catch (_) {}
    return true;
  }

  function focusParagraph(index) {
    const item = allParagraphs().find((p) => p.index === index);
    if (!item) return;
    item.el.classList.add('active');
    item.el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }

  async function playFrom(index, token) {
    if (!isPlaying || token !== playbackToken) return;
    const item = allParagraphs().find((p) => p.index === index);
    if (!item) {
      finish();
      toast('🎧 Глава закончилась');
      return;
    }

    activeParagraph = index;
    focusParagraph(index);
    setButtonState('playing');

    try {
      const ctx = getContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const audioBuffer = await requestAudio(item.text, detectLang());
      if (!isPlaying || token !== playbackToken) return;
      const decoded = await ctx.decodeAudioData(audioBuffer.slice(0));
      if (!isPlaying || token !== playbackToken) return;

      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      currentSource = source;
      source.onended = () => {
        if (!isPlaying || token !== playbackToken || currentSource !== source) return;
        currentSource = null;
        updateReaderPosition(index + 1);
        setTimeout(() => playFrom(index + 1, token), 80);
      };
      source.start(0);
    } catch (error) {
      if (token !== playbackToken) return;
      finish();
      toast('⚠️ Озвучка остановилась: ' + String(error?.message || error).slice(0, 170), 6500);
    }
  }

  function start() {
    const list = allParagraphs();
    if (!list.length) {
      toast('Сначала открой книгу или главу.');
      return;
    }
    stop(false);
    isPlaying = true;
    playbackToken += 1;
    const token = playbackToken;
    const startIndex = selectedIndex();
    activeParagraph = startIndex;
    setButtonState('playing');
    playFrom(startIndex, token);
  }

  function finish() {
    isPlaying = false;
    currentSource = null;
    setButtonState('done');
  }

  function stop(showToast = true) {
    playbackToken += 1;
    isPlaying = false;
    if (currentSource) {
      try { currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
    setButtonState('done');
    if (showToast) toast('⏹ Озвучка остановлена');
  }

  function toggle() {
    if (isPlaying) stop();
    else start();
  }

  function wirePinnedButton() {
    const button = listenButton();
    if (!button || button.dataset.readerBookAudioBound === '1') return;
    button.dataset.readerBookAudioBound = '1';
    button.onclick = function (event) {
      try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
      toggle();
      return false;
    };
    setButtonState('idle');
  }

  function boot() {
    wirePinnedButton();
    // The button is part of the static reader shell; this only retries until the shell exists.
    if (!listenButton()) setTimeout(boot, 300);
  }

  window.an2ReaderStartBookAudio = start;
  window.an2ReaderStopBookAudio = stop;
  boot();
})();

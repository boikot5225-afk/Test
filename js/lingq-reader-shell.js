/*
 * LingQ-style reader shell for Reader AI.
 * Presentation and interaction layer only: books, dictionaries, AI, TTS,
 * persistence and SRS remain owned by the existing Reader AI modules.
 */
(() => {
  'use strict';

  const BUILD = '0.1.0';
  const MODE_KEY = 'an2_lq_reader_mode_v1';
  const MARKS_KEY = 'an2_lq_reader_marks_v1';
  const mounted = new WeakSet();
  let activeParagraphIndex = 0;
  let syncTimer = 0;
  let shellObserver = null;

  function q(sel, root = document) { return root.querySelector(sel); }
  function qa(sel, root = document) { return [...root.querySelectorAll(sel)]; }
  function call(name, ...args) {
    const fn = window[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); }
    catch (error) {
      console.error(`[lingq-shell] ${name}`, error);
      window.showToast?.('⚠️ ' + (error?.message || error));
      return undefined;
    }
  }
  function later(fn, delay = 0) { window.setTimeout(fn, delay); }
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function injectStyles() {
    if (document.getElementById('lingq-reader-shell-style')) return;
    const style = document.createElement('style');
    style.id = 'lingq-reader-shell-style';
    style.textContent = `
      :root {
        --lq-green:#13a463;
        --lq-green-soft:rgba(19,164,99,.14);
        --lq-blue:#198ad6;
        --lq-blue-soft:rgba(25,138,214,.18);
        --lq-yellow:#f0c84b;
        --lq-yellow-soft:rgba(240,200,75,.22);
        --lq-shell-bg:var(--bg,#121212);
        --lq-shell-panel:var(--surface,#1c1c1c);
        --lq-shell-border:var(--border,rgba(255,255,255,.12));
        --lq-shell-text:var(--text,#f2f2f2);
        --lq-shell-muted:var(--text-muted,#a6a6a6);
      }

      #reader-reading-view.lq-shell-active {
        position:fixed!important;
        inset:0!important;
        z-index:620!important;
        flex-direction:column!important;
        background:var(--lq-shell-bg)!important;
        overflow:hidden!important;
        padding:0!important;
      }
      #reader-reading-view.lq-shell-active > .rd-top,
      #reader-reading-view.lq-shell-active > .rd-bot { display:none!important; }
      #reader-reading-view.lq-shell-active .rd-scroll {
        position:relative!important;
        inset:auto!important;
        flex:1 1 auto!important;
        min-height:0!important;
        overflow:auto!important;
        padding:18px max(18px,env(safe-area-inset-left)) calc(108px + env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-right))!important;
        scroll-padding-top:80px!important;
        background:var(--lq-shell-bg)!important;
      }
      #reader-reading-view.lq-shell-active #reader-chapter-text {
        width:min(760px,100%)!important;
        margin:0 auto!important;
      }
      #reader-reading-view.lq-shell-active .reader-paragraph {
        border-radius:12px;
        padding:9px 8px;
        margin:0 0 5px;
        transition:background .16s ease,transform .16s ease,opacity .16s ease;
      }
      #reader-reading-view.lq-shell-active .reader-paragraph.active {
        background:color-mix(in srgb,var(--lq-green) 8%,transparent);
      }
      #reader-reading-view.lq-shell-active .reader-word {
        border-radius:4px;
        padding:0 1px;
        text-decoration:none!important;
        box-decoration-break:clone;
        -webkit-box-decoration-break:clone;
      }
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-new,
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-seen,
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-looked {
        background:var(--lq-blue-soft)!important;
        box-shadow:inset 0 -2px 0 rgba(25,138,214,.45);
      }
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-saved,
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-learning,
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-problem {
        background:var(--lq-yellow-soft)!important;
        box-shadow:inset 0 -2px 0 rgba(240,200,75,.55);
      }
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-known,
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-familiar,
      #reader-reading-view.lq-shell-active.lq-marks-on .reader-word.rw-faded {
        background:transparent!important;
        box-shadow:none!important;
      }

      .lq-reader-top {
        flex:none;
        min-height:58px;
        padding:max(8px,env(safe-area-inset-top)) max(10px,env(safe-area-inset-right)) 8px max(10px,env(safe-area-inset-left));
        display:grid;
        grid-template-columns:44px minmax(0,1fr) auto;
        align-items:center;
        gap:8px;
        background:color-mix(in srgb,var(--lq-shell-panel) 94%,transparent);
        border-bottom:1px solid var(--lq-shell-border);
        backdrop-filter:blur(14px);
        -webkit-backdrop-filter:blur(14px);
        z-index:8;
      }
      .lq-icon-btn,.lq-bar-btn {
        appearance:none;
        border:0;
        color:var(--lq-shell-text);
        background:transparent;
        font:inherit;
        cursor:pointer;
        -webkit-tap-highlight-color:transparent;
      }
      .lq-icon-btn {
        width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:1.15rem;
      }
      .lq-icon-btn:active,.lq-bar-btn:active { background:rgba(127,127,127,.18); }
      .lq-reader-heading { min-width:0;cursor:pointer; }
      .lq-reader-title { font-size:.88rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--lq-shell-text); }
      .lq-reader-subtitle { margin-top:2px;font-size:.68rem;color:var(--lq-shell-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .lq-reader-top-actions { display:flex;align-items:center;gap:1px; }
      .lq-count-pill { min-width:32px;height:30px;padding:0 8px;border:1px solid var(--lq-shell-border);border-radius:15px;display:flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--lq-shell-muted); }

      .lq-reader-bottom {
        position:absolute;
        left:0;right:0;bottom:0;
        z-index:9;
        padding:6px max(10px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));
        background:color-mix(in srgb,var(--lq-shell-panel) 96%,transparent);
        border-top:1px solid var(--lq-shell-border);
        backdrop-filter:blur(16px);
        -webkit-backdrop-filter:blur(16px);
      }
      .lq-progress-track { height:3px;background:rgba(127,127,127,.24);border-radius:3px;overflow:hidden;margin:0 4px 6px; }
      .lq-progress-fill { height:100%;width:0;background:var(--lq-green);transition:width .2s ease; }
      .lq-bottom-grid { display:grid;grid-template-columns:1fr 1fr 1.22fr 1fr 1fr;align-items:center;gap:2px; }
      .lq-bar-btn { min-height:48px;border-radius:11px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:1.05rem; }
      .lq-bar-btn small { font-size:.6rem;color:var(--lq-shell-muted);font-weight:500; }
      .lq-bar-btn.primary { color:white;background:var(--lq-green);border-radius:25px;min-height:46px;margin:0 4px; }
      .lq-bar-btn.on { color:var(--lq-green);background:var(--lq-green-soft); }

      .lq-reader-sheet-back { position:fixed;inset:0;z-index:798;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .18s ease; }
      .lq-reader-sheet-back.open { opacity:1;pointer-events:auto; }
      .lq-reader-sheet {
        position:fixed;left:0;right:0;bottom:0;z-index:799;
        max-height:min(78vh,640px);overflow:auto;
        padding:10px 14px calc(18px + env(safe-area-inset-bottom));
        background:var(--lq-shell-panel);color:var(--lq-shell-text);
        border-radius:22px 22px 0 0;border:1px solid var(--lq-shell-border);border-bottom:0;
        transform:translateY(104%);transition:transform .22s ease;
        box-shadow:0 -18px 50px rgba(0,0,0,.35);
      }
      .lq-reader-sheet.open { transform:translateY(0); }
      .lq-sheet-grab { width:38px;height:4px;border-radius:4px;background:rgba(127,127,127,.45);margin:0 auto 14px; }
      .lq-sheet-title { font-size:1rem;font-weight:700;margin:0 4px 12px; }
      .lq-menu-row { width:100%;border:0;border-radius:12px;background:transparent;color:inherit;display:flex;align-items:center;gap:12px;padding:12px 10px;text-align:left;font:inherit;cursor:pointer; }
      .lq-menu-row:active { background:rgba(127,127,127,.15); }
      .lq-menu-row .icon { width:30px;height:30px;border-radius:9px;background:rgba(127,127,127,.13);display:grid;place-items:center;flex:none; }
      .lq-menu-row b { display:block;font-size:.86rem; }
      .lq-menu-row span.meta { display:block;font-size:.68rem;color:var(--lq-shell-muted);margin-top:2px; }
      .lq-toggle { margin-left:auto;width:42px;height:24px;border-radius:12px;background:rgba(127,127,127,.34);position:relative;flex:none; }
      .lq-toggle::after { content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:white;transition:transform .16s ease; }
      .lq-menu-row.on .lq-toggle { background:var(--lq-green); }
      .lq-menu-row.on .lq-toggle::after { transform:translateX(18px); }

      #reader-reading-view.lq-sentence-mode .rd-scroll { padding-top:24px!important; }
      #reader-reading-view.lq-sentence-mode .reader-paragraph { display:none!important; }
      #reader-reading-view.lq-sentence-mode .reader-paragraph.lq-current-sentence {
        display:block!important;
        min-height:calc(100vh - 230px);
        margin:0 auto!important;
        padding:24px 16px!important;
        background:transparent!important;
        font-size:1.16em;
        line-height:1.9;
      }
      #reader-reading-view.lq-sentence-mode .reader-paragraph.lq-current-sentence .reader-translation,
      #reader-reading-view.lq-sentence-mode .reader-paragraph.lq-current-sentence .reader-analysis {
        display:block;
      }
      .lq-sentence-counter { font-variant-numeric:tabular-nums; }

      #reader-word-panel.reader-word-panel.lq-word-panel {
        z-index:810!important;
        max-height:min(78vh,720px)!important;
        border-radius:22px 22px 0 0!important;
        padding:10px 16px calc(16px + env(safe-area-inset-bottom))!important;
        box-shadow:0 -20px 60px rgba(0,0,0,.38)!important;
      }
      .lq-word-statuses { display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 12px; }
      .lq-word-status { border:1px solid var(--lq-shell-border);border-radius:10px;background:transparent;color:var(--lq-shell-text);padding:9px 4px;font-size:.7rem;font-weight:650;cursor:pointer; }
      .lq-word-status.study { background:var(--lq-yellow-soft);border-color:rgba(240,200,75,.6); }
      .lq-word-status.known { background:var(--lq-green-soft);border-color:rgba(19,164,99,.55); }
      .lq-word-status.problem { background:rgba(220,70,70,.13);border-color:rgba(220,70,70,.5); }
      .lq-word-nav { display:flex;gap:8px;margin-top:10px; }
      .lq-word-nav button { flex:1;border:1px solid var(--lq-shell-border);border-radius:10px;background:transparent;color:var(--lq-shell-text);padding:9px;font:inherit;font-size:.75rem;cursor:pointer; }

      .lq-library-tools { display:grid;grid-template-columns:1fr auto;gap:8px;margin:8px 0 14px; }
      .lq-library-search { width:100%;box-sizing:border-box;border:1px solid var(--lq-shell-border);border-radius:12px;background:var(--surface2,rgba(127,127,127,.1));color:var(--lq-shell-text);padding:11px 13px;font:inherit;outline:none; }
      .lq-library-count { display:flex;align-items:center;padding:0 11px;border:1px solid var(--lq-shell-border);border-radius:12px;color:var(--lq-shell-muted);font-size:.72rem;white-space:nowrap; }
      .lq-library-empty { display:none;text-align:center;padding:34px 10px;color:var(--lq-shell-muted);font-size:.82rem; }

      @media (min-width:860px) {
        #reader-word-panel.reader-word-panel.lq-word-panel {
          left:auto!important;right:18px!important;bottom:18px!important;width:min(420px,calc(100vw - 36px))!important;border-radius:18px!important;
          max-height:calc(100vh - 36px)!important;
        }
        .lq-reader-sheet { left:auto;right:18px;bottom:18px;width:390px;border-radius:18px;border-bottom:1px solid var(--lq-shell-border); }
      }
    `;
    document.head.appendChild(style);
  }

  function buildReaderChrome(view) {
    if (q('.lq-reader-top', view)) return;
    const top = document.createElement('div');
    top.className = 'lq-reader-top';
    top.innerHTML = `
      <button class="lq-icon-btn" data-lq-action="back" aria-label="Библиотека">←</button>
      <div class="lq-reader-heading" data-lq-action="toc">
        <div class="lq-reader-title">Reader AI</div>
        <div class="lq-reader-subtitle">читалка</div>
      </div>
      <div class="lq-reader-top-actions">
        <span class="lq-count-pill lq-sentence-counter">1/1</span>
        <button class="lq-icon-btn" data-lq-action="settings" aria-label="Настройки">⋮</button>
      </div>`;

    const bottom = document.createElement('div');
    bottom.className = 'lq-reader-bottom';
    bottom.innerHTML = `
      <div class="lq-progress-track"><div class="lq-progress-fill"></div></div>
      <div class="lq-bottom-grid">
        <button class="lq-bar-btn" data-lq-action="prev"><span>‹</span><small>назад</small></button>
        <button class="lq-bar-btn" data-lq-action="translate"><span>文</span><small>перевод</small></button>
        <button class="lq-bar-btn primary" data-lq-action="listen"><span>▶</span><small>слушать</small></button>
        <button class="lq-bar-btn" data-lq-action="mode"><span>▤</span><small>предложения</small></button>
        <button class="lq-bar-btn" data-lq-action="next"><span>›</span><small>дальше</small></button>
      </div>`;

    view.prepend(top);
    view.append(bottom);
    bindChromeActions(view);
  }

  function buildSettingsSheet() {
    if (document.getElementById('lq-reader-settings')) return;
    const back = document.createElement('div');
    back.id = 'lq-reader-settings-back';
    back.className = 'lq-reader-sheet-back';
    const sheet = document.createElement('div');
    sheet.id = 'lq-reader-settings';
    sheet.className = 'lq-reader-sheet';
    sheet.innerHTML = `
      <div class="lq-sheet-grab"></div>
      <div class="lq-sheet-title">Чтение</div>
      <button class="lq-menu-row" data-lq-menu="marks"><span class="icon">◩</span><span><b>Подсветка слов</b><span class="meta">новые — синие, изучаемые — жёлтые</span></span><i class="lq-toggle"></i></button>
      <button class="lq-menu-row" data-lq-menu="sentence"><span class="icon">▤</span><span><b>Режим предложений</b><span class="meta">одно предложение и быстрый разбор</span></span><i class="lq-toggle"></i></button>
      <button class="lq-menu-row" data-lq-menu="display"><span class="icon">Аа</span><span><b>Текст и фон</b><span class="meta">шрифт, размер, интервал и тема</span></span></button>
      <button class="lq-menu-row" data-lq-menu="pinyin"><span class="icon">拼</span><span><b>Пиньинь / чтение</b><span class="meta">переключить подписи над иероглифами</span></span></button>
      <button class="lq-menu-row" data-lq-menu="toc"><span class="icon">☰</span><span><b>Оглавление</b><span class="meta">перейти к другой главе</span></span></button>
      <button class="lq-menu-row" data-lq-menu="analysis"><span class="icon">🧩</span><span><b>Разобрать текущий фрагмент</b><span class="meta">грамматика Reader AI</span></span></button>
      <button class="lq-menu-row" data-lq-menu="copy"><span class="icon">⧉</span><span><b>Скопировать фрагмент</b><span class="meta">текущий абзац или предложение</span></span></button>`;
    document.body.append(back, sheet);
    back.addEventListener('click', closeSettings);
    sheet.addEventListener('click', (event) => {
      const row = event.target.closest('[data-lq-menu]');
      if (!row) return;
      const action = row.dataset.lqMenu;
      if (action === 'marks') toggleMarks();
      if (action === 'sentence') toggleSentenceMode();
      if (action === 'display') call('readerToggleDisplayPanel');
      if (action === 'pinyin') call('readerCycleZhPinyinMode');
      if (action === 'toc') call('readerOpenToc');
      if (action === 'analysis') call('readerAction', null, 'analyze', activeParagraphIndex);
      if (action === 'copy') call('readerCopyParagraph', activeParagraphIndex);
      if (!['marks','sentence'].includes(action)) closeSettings();
      scheduleSync();
    });
  }

  function openSettings() {
    buildSettingsSheet();
    q('#lq-reader-settings-back')?.classList.add('open');
    q('#lq-reader-settings')?.classList.add('open');
    syncSettingsRows();
  }
  function closeSettings() {
    q('#lq-reader-settings-back')?.classList.remove('open');
    q('#lq-reader-settings')?.classList.remove('open');
  }

  function bindChromeActions(view) {
    view.addEventListener('click', (event) => {
      const button = event.target.closest('[data-lq-action]');
      if (!button || !view.contains(button)) return;
      const action = button.dataset.lqAction;
      if (action === 'back') call('readerBackToLibrary');
      if (action === 'toc') call('readerOpenToc');
      if (action === 'settings') openSettings();
      if (action === 'prev') navigate(-1);
      if (action === 'next') navigate(1);
      if (action === 'listen') call('readerListenToggle');
      if (action === 'translate') call('readerAction', null, 'translate', activeParagraphIndex);
      if (action === 'mode') toggleSentenceMode();
      scheduleSync();
    });
  }

  function mountReadingView() {
    const view = document.getElementById('reader-reading-view');
    if (!view) return false;
    injectStyles();
    buildReaderChrome(view);
    buildSettingsSheet();
    view.classList.add('lq-shell-active');
    const storedMarks = localStorage.getItem(MARKS_KEY);
    view.classList.toggle('lq-marks-on', storedMarks !== '0');
    applyMode(localStorage.getItem(MODE_KEY) || 'page', false);
    decorateWordPanel();
    observeReader(view);
    syncShell();
    return true;
  }

  function observeReader(view) {
    if (shellObserver) return;
    shellObserver = new MutationObserver(() => scheduleSync());
    shellObserver.observe(view, { subtree:true, childList:true, attributes:true, attributeFilter:['class','style'] });
  }

  function scheduleSync() {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(syncShell, 28);
  }

  function paragraphNodes() {
    return qa('#reader-chapter-text .reader-paragraph');
  }

  function resolveActiveParagraph() {
    const rows = paragraphNodes();
    if (!rows.length) return { rows, index:0, position:0 };
    let row = q('#reader-chapter-text .reader-paragraph.active') || q('#reader-chapter-text .reader-paragraph.lq-current-sentence');
    if (!row) {
      const scroller = q('#reader-reading-view .rd-scroll');
      if (scroller) {
        const top = scroller.getBoundingClientRect().top + 90;
        row = rows.find(item => item.getBoundingClientRect().bottom >= top) || rows[0];
      } else row = rows[0];
    }
    const index = Number(row?.dataset?.p);
    const position = Math.max(0, rows.indexOf(row));
    return { rows, row, index:Number.isFinite(index) ? index : position, position };
  }

  function applySentenceVisibility() {
    const view = document.getElementById('reader-reading-view');
    if (!view?.classList.contains('lq-sentence-mode')) return;
    const { rows, row, index } = resolveActiveParagraph();
    if (!rows.length) return;
    activeParagraphIndex = index;
    rows.forEach(item => item.classList.toggle('lq-current-sentence', item === row));
    row?.scrollIntoView({ block:'start' });
  }

  function syncShell() {
    const view = document.getElementById('reader-reading-view');
    if (!view) return;
    if (!view.classList.contains('lq-shell-active')) mountReadingView();

    const title = q('#reader-book-title')?.textContent?.trim() || 'Reader AI';
    const subtitle = q('#reader-chapter-title')?.textContent?.trim() || 'чтение';
    const topTitle = q('.lq-reader-title', view);
    const topSubtitle = q('.lq-reader-subtitle', view);
    if (topTitle) topTitle.textContent = title;
    if (topSubtitle) topSubtitle.textContent = subtitle;

    const active = resolveActiveParagraph();
    activeParagraphIndex = active.index;
    if (view.classList.contains('lq-sentence-mode')) applySentenceVisibility();
    const counter = q('.lq-sentence-counter', view);
    if (counter) counter.textContent = `${active.position + 1}/${Math.max(1,active.rows.length)}`;

    const sourceProgress = q('#reader-progress-bar');
    let pct = Number.parseFloat(sourceProgress?.style?.width || '');
    if (!Number.isFinite(pct)) pct = active.rows.length ? ((active.position + 1) / active.rows.length) * 100 : 0;
    const fill = q('.lq-progress-fill', view);
    if (fill) fill.style.width = `${Math.max(0,Math.min(100,pct))}%`;

    const modeButton = q('[data-lq-action="mode"]', view);
    const sentence = view.classList.contains('lq-sentence-mode');
    modeButton?.classList.toggle('on', sentence);
    const modeLabel = q('small', modeButton || document);
    if (modeLabel) modeLabel.textContent = sentence ? 'страница' : 'предложения';

    decorateWordPanel();
    enhanceLibrary();
    syncSettingsRows();
  }

  function applyMode(mode, save = true) {
    const view = document.getElementById('reader-reading-view');
    if (!view) return;
    const sentence = mode === 'sentence';
    view.classList.toggle('lq-sentence-mode', sentence);
    if (save) localStorage.setItem(MODE_KEY, sentence ? 'sentence' : 'page');
    if (sentence) later(applySentenceVisibility, 0);
    else qa('.reader-paragraph.lq-current-sentence', view).forEach(el => el.classList.remove('lq-current-sentence'));
    scheduleSync();
  }
  function toggleSentenceMode() {
    const view = document.getElementById('reader-reading-view');
    applyMode(view?.classList.contains('lq-sentence-mode') ? 'page' : 'sentence');
  }
  function toggleMarks() {
    const view = document.getElementById('reader-reading-view');
    if (!view) return;
    const on = !view.classList.contains('lq-marks-on');
    view.classList.toggle('lq-marks-on', on);
    localStorage.setItem(MARKS_KEY, on ? '1' : '0');
    syncSettingsRows();
  }
  function syncSettingsRows() {
    const view = document.getElementById('reader-reading-view');
    q('[data-lq-menu="marks"]')?.classList.toggle('on', !!view?.classList.contains('lq-marks-on'));
    q('[data-lq-menu="sentence"]')?.classList.toggle('on', !!view?.classList.contains('lq-sentence-mode'));
  }

  function navigate(direction) {
    const view = document.getElementById('reader-reading-view');
    if (view?.classList.contains('lq-sentence-mode')) {
      call(direction > 0 ? 'readerNextParagraph' : 'readerPrevParagraph');
      later(() => { applySentenceVisibility(); scheduleSync(); }, 30);
      return;
    }
    call(direction > 0 ? 'readerNextParagraph' : 'readerPrevParagraph');
  }

  function decorateWordPanel() {
    const panel = document.getElementById('reader-word-panel');
    if (!panel || mounted.has(panel)) return;
    mounted.add(panel);
    panel.classList.add('lq-word-panel');
    const status = document.createElement('div');
    status.className = 'lq-word-statuses';
    status.innerHTML = `
      <button class="lq-word-status" data-lq-word="new">Новое</button>
      <button class="lq-word-status study" data-lq-word="study">Изучаю</button>
      <button class="lq-word-status known" data-lq-word="known">Знаю</button>
      <button class="lq-word-status problem" data-lq-word="problem">Трудное</button>`;
    const analysis = q('#reader-word-analysis', panel);
    panel.insertBefore(status, analysis || panel.children[2] || null);

    const nav = document.createElement('div');
    nav.className = 'lq-word-nav';
    nav.innerHTML = '<button data-lq-word-nav="prev">← предыдущее</button><button data-lq-word-nav="next">следующее →</button>';
    panel.appendChild(nav);

    panel.addEventListener('click', (event) => {
      const stateButton = event.target.closest('[data-lq-word]');
      if (stateButton) {
        const state = stateButton.dataset.lqWord;
        if (state === 'new') call('readerCloseWordPanel');
        if (state === 'study') call('readerSaveWord');
        if (state === 'known') call('readerMarkSelectedWordKnown');
        if (state === 'problem') call('readerMarkSelectedWordProblem');
        scheduleSync();
        return;
      }
      const navButton = event.target.closest('[data-lq-word-nav]');
      if (navButton) openAdjacentWord(navButton.dataset.lqWordNav === 'next' ? 1 : -1);
    });
  }

  function openAdjacentWord(direction) {
    const words = qa('#reader-chapter-text .reader-word').filter(el => el.offsetParent !== null);
    if (!words.length) return;
    const title = q('#reader-word-title')?.textContent?.trim();
    let current = words.findIndex(el => (el.dataset.word || el.textContent || '').trim() === title && el.closest('.reader-paragraph')?.classList.contains('active'));
    if (current < 0) current = words.findIndex(el => (el.dataset.word || el.textContent || '').trim() === title);
    const next = words[(Math.max(0,current) + direction + words.length) % words.length];
    next?.scrollIntoView({ block:'center',behavior:'smooth' });
    next?.click();
  }

  function enhanceLibrary() {
    const view = document.getElementById('reader-library-view');
    const list = document.getElementById('reader-library-list');
    if (!view || !list || q('.lq-library-tools', view)) return;
    const tools = document.createElement('div');
    tools.className = 'lq-library-tools';
    tools.innerHTML = '<input class="lq-library-search" type="search" placeholder="Поиск по библиотеке"><span class="lq-library-count">0 текстов</span>';
    const empty = document.createElement('div');
    empty.className = 'lq-library-empty';
    empty.textContent = 'Ничего не найдено';
    list.before(tools);
    list.after(empty);
    const input = q('.lq-library-search', tools);
    input?.addEventListener('input', () => filterLibrary(input.value));
    later(() => filterLibrary(input?.value || ''), 0);
  }

  function filterLibrary(query) {
    const list = document.getElementById('reader-library-list');
    if (!list) return;
    const value = String(query || '').trim().toLocaleLowerCase();
    const cards = [...list.children].filter(el => el.nodeType === 1);
    let visible = 0;
    cards.forEach(card => {
      const show = !value || String(card.textContent || '').toLocaleLowerCase().includes(value);
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const count = q('.lq-library-count');
    if (count) count.textContent = `${visible} ${visible === 1 ? 'текст' : visible > 1 && visible < 5 ? 'текста' : 'текстов'}`;
    const empty = q('.lq-library-empty');
    if (empty) empty.style.display = cards.length && !visible ? 'block' : 'none';
  }

  function wrapGlobal(name) {
    const original = window[name];
    if (typeof original !== 'function' || original.__lqWrapped) return false;
    const wrapped = function(...args) {
      const result = original.apply(this,args);
      if (result && typeof result.then === 'function') result.finally(scheduleSync);
      else later(scheduleSync, 0);
      return result;
    };
    wrapped.__lqWrapped = true;
    wrapped.__lqOriginal = original;
    window[name] = wrapped;
    return true;
  }

  function installWrappers() {
    ['readerOpenBook','readerBackToLibrary','readerNextParagraph','readerPrevParagraph','readerNextChapter','readerPrevChapter','renderReaderScreen','readerOpenWordPanel','readerCloseWordPanel','toggleReaderTranslations'].forEach(wrapGlobal);
  }

  function installKeyboard() {
    document.addEventListener('keydown', (event) => {
      const view = document.getElementById('reader-reading-view');
      if (!view || view.style.display === 'none' || event.target?.matches?.('input,textarea,select')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); toggleSentenceMode(); }
      if (event.key === ' ') { event.preventDefault(); call('readerListenToggle'); }
      if (event.key === 'Escape') { closeSettings(); call('readerCloseWordPanel'); }
    });
  }

  function boot() {
    injectStyles();
    enhanceLibrary();
    mountReadingView();
    installWrappers();
    installKeyboard();
    const retry = window.setInterval(() => {
      installWrappers();
      mountReadingView();
      enhanceLibrary();
      if (typeof window.readerOpenBook === 'function' && document.getElementById('reader-reading-view')) {
        window.clearInterval(retry);
        scheduleSync();
      }
    }, 250);
    later(() => window.clearInterval(retry), 15000);
    console.info(`[lingq-shell] Reader AI shell ${BUILD} ready`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();

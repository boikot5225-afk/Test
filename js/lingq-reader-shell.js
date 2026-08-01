/* Reader AI — LingQ-style reading shell.
 * UI adapter only. Reader AI remains the source of truth for books,
 * dictionaries, AI, audio, progress, storage and word states.
 */
(() => {
  'use strict';

  const VERSION = '0.2.0';
  const SENTENCE_KEY = 'reader_ai_lingq_sentence_mode_v1';
  const mountedPanels = new WeakSet();
  let observer = null;
  let syncTimer = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const readFlag = (key, fallback = false) => {
    try { const value = localStorage.getItem(key); return value == null ? fallback : value === '1'; }
    catch { return fallback; }
  };
  const writeFlag = (key, value) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch {} };
  const invoke = (name, ...args) => {
    const fn = window[name];
    if (typeof fn !== 'function') {
      console.warn(`[lingq-shell] ${name} is unavailable`);
      return undefined;
    }
    try { return fn(...args); }
    catch (error) {
      console.error(`[lingq-shell] ${name}`, error);
      window.showToast?.(`⚠️ ${error?.message || error}`);
      return undefined;
    }
  };

  function installStyles() {
    if ($('#lingq-shell-style')) return;
    const style = document.createElement('style');
    style.id = 'lingq-shell-style';
    style.textContent = `
      :root{
        --lqs-green:#19a566;
        --lqs-green-soft:rgba(25,165,102,.14);
        --lqs-blue:#258bd2;
        --lqs-blue-soft:rgba(37,139,210,.19);
        --lqs-yellow:#e4bd39;
        --lqs-yellow-soft:rgba(228,189,57,.23);
      }
      #reader-reading-view.lqs-active{
        position:fixed!important;inset:0!important;z-index:620!important;
        display:flex!important;flex-direction:column!important;overflow:hidden!important;
        background:var(--bg)!important;padding:0!important;
      }
      #reader-reading-view.lqs-active>.rd-top,
      #reader-reading-view.lqs-active>.rd-bot,
      #reader-reading-view.lqs-active>.rd-free-prog{display:none!important}
      #reader-reading-view.lqs-active>.rd-scroll{
        position:relative!important;inset:auto!important;flex:1 1 auto!important;min-height:0!important;
        padding:18px max(18px,env(safe-area-inset-right)) calc(104px + env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))!important;
        overflow:auto!important;scroll-padding-top:82px!important;background:var(--bg)!important;
      }
      #reader-reading-view.lqs-active #reader-chapter-text{width:min(790px,100%)!important;margin:0 auto!important}
      #reader-reading-view.lqs-active .reader-paragraph{border-radius:11px;padding:8px 7px;margin-bottom:3px;transition:background .16s ease,opacity .16s ease}
      #reader-reading-view.lqs-active .reader-paragraph.active{background:var(--lqs-green-soft)}
      #reader-reading-view.lqs-active .reader-word{border-radius:3px;padding:0 1px;text-decoration:none!important;box-decoration-break:clone;-webkit-box-decoration-break:clone}
      #reader-reading-view.lqs-active .reader-word.rw-new,
      #reader-reading-view.lqs-active .reader-word.rw-looked,
      #reader-reading-view.lqs-active .reader-word.rw-seen{background:var(--lqs-blue-soft)!important;box-shadow:inset 0 -2px rgba(37,139,210,.45)}
      #reader-reading-view.lqs-active .reader-word.rw-learning,
      #reader-reading-view.lqs-active .reader-word.rw-saved,
      #reader-reading-view.lqs-active .reader-word.rw-problem{background:var(--lqs-yellow-soft)!important;box-shadow:inset 0 -2px rgba(228,189,57,.56)}
      #reader-reading-view.lqs-active .reader-word.rw-known,
      #reader-reading-view.lqs-active .reader-word.rw-familiar,
      #reader-reading-view.lqs-active .reader-word.rw-faded{background:transparent!important;box-shadow:none!important}

      .lqs-top{
        flex:none;z-index:30;min-height:58px;display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:6px;
        padding:max(7px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) 7px max(8px,env(safe-area-inset-left));
        background:color-mix(in srgb,var(--surface) 95%,transparent);border-bottom:1px solid var(--border);
        backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)
      }
      .lqs-button{appearance:none;border:0;background:transparent;color:var(--text);font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
      .lqs-icon{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:1.05rem}
      .lqs-icon:active,.lqs-nav:active,.lqs-menu-row:active{background:rgba(127,127,127,.17)}
      .lqs-heading{min-width:0;cursor:pointer}
      .lqs-title{font-size:.88rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lqs-subtitle{font-size:.67rem;color:var(--text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lqs-top-actions{display:flex;align-items:center}
      .lqs-counter{min-width:35px;padding:5px 8px;border:1px solid var(--border);border-radius:16px;color:var(--text-muted);font-size:.67rem;text-align:center;font-variant-numeric:tabular-nums}

      .lqs-bottom{
        position:absolute;left:0;right:0;bottom:0;z-index:31;
        padding:5px max(9px,env(safe-area-inset-right)) max(7px,env(safe-area-inset-bottom)) max(9px,env(safe-area-inset-left));
        background:color-mix(in srgb,var(--surface) 96%,transparent);border-top:1px solid var(--border);
        backdrop-filter:blur(15px);-webkit-backdrop-filter:blur(15px)
      }
      .lqs-progress{height:3px;margin:0 4px 5px;background:rgba(127,127,127,.25);border-radius:4px;overflow:hidden}
      .lqs-progress>i{display:block;height:100%;width:0;background:var(--lqs-green);transition:width .18s ease}
      .lqs-nav-grid{display:grid;grid-template-columns:1fr 1fr 1.18fr 1fr 1fr;gap:2px;align-items:center}
      .lqs-nav{min-height:48px;border-radius:11px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:1.03rem}
      .lqs-nav small{font-size:.59rem;color:var(--text-muted);font-weight:500}
      .lqs-nav.primary{min-height:45px;margin:0 4px;border-radius:24px;background:var(--lqs-green);color:#fff}
      .lqs-nav.on{background:var(--lqs-green-soft);color:var(--lqs-green)}

      .lqs-sheet-back{position:fixed;inset:0;z-index:798;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .18s}
      .lqs-sheet-back.open{opacity:1;pointer-events:auto}
      .lqs-sheet{position:fixed;left:0;right:0;bottom:0;z-index:799;max-height:min(80vh,680px);overflow:auto;
        padding:9px 14px calc(17px + env(safe-area-inset-bottom));background:var(--surface);color:var(--text);
        border:1px solid var(--border);border-bottom:0;border-radius:22px 22px 0 0;box-shadow:0 -18px 50px rgba(0,0,0,.36);
        transform:translateY(104%);transition:transform .21s ease}
      .lqs-sheet.open{transform:translateY(0)}
      .lqs-grab{width:38px;height:4px;border-radius:4px;background:rgba(127,127,127,.44);margin:0 auto 13px}
      .lqs-sheet-title{font-weight:700;margin:0 5px 9px}
      .lqs-menu-row{width:100%;min-height:51px;border:0;border-radius:12px;background:transparent;color:inherit;display:flex;align-items:center;gap:12px;padding:9px 10px;text-align:left;font:inherit;cursor:pointer}
      .lqs-menu-icon{width:31px;height:31px;border-radius:9px;background:rgba(127,127,127,.13);display:grid;place-items:center;flex:none}
      .lqs-menu-text{min-width:0;flex:1}.lqs-menu-text b{display:block;font-size:.84rem}.lqs-menu-text small{display:block;color:var(--text-muted);font-size:.66rem;margin-top:2px}
      .lqs-toggle{width:42px;height:24px;border-radius:13px;background:rgba(127,127,127,.34);position:relative;flex:none}
      .lqs-toggle:after{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:#fff;transition:transform .15s}
      .lqs-menu-row.on .lqs-toggle{background:var(--lqs-green)}.lqs-menu-row.on .lqs-toggle:after{transform:translateX(18px)}

      #reader-reading-view.lqs-sentence .reader-paragraph{display:none!important}
      #reader-reading-view.lqs-sentence .reader-paragraph.lqs-current{display:block!important;min-height:calc(100dvh - 224px);padding:24px 15px!important;margin:0 auto!important;background:transparent!important;font-size:1.12em;line-height:1.9}
      #reader-reading-view.lqs-sentence>.rd-scroll{padding-top:22px!important}

      #reader-word-panel.reader-word-panel.lqs-word-panel{z-index:810!important;max-height:min(80vh,730px)!important;border-radius:22px 22px 0 0!important;padding-bottom:calc(15px + env(safe-area-inset-bottom))!important}
      .lqs-word-states{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 11px}
      .lqs-word-state{border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);padding:9px 3px;font:inherit;font-size:.68rem;font-weight:650;cursor:pointer}
      .lqs-word-state.study{background:var(--lqs-yellow-soft);border-color:rgba(228,189,57,.62)}
      .lqs-word-state.known{background:var(--lqs-green-soft);border-color:rgba(25,165,102,.56)}
      .lqs-word-state.problem{background:rgba(205,65,65,.14);border-color:rgba(205,65,65,.52)}
      .lqs-word-arrows{display:flex;gap:7px;margin-top:10px}.lqs-word-arrows button{flex:1;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);padding:9px;font:inherit;font-size:.72rem;cursor:pointer}

      .lqs-library-tools{display:grid;grid-template-columns:1fr auto;gap:8px;margin:8px 0 14px}
      .lqs-library-search{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--surface2);color:var(--text);font:inherit;outline:none}
      .lqs-library-count{display:flex;align-items:center;padding:0 11px;border:1px solid var(--border);border-radius:12px;color:var(--text-muted);font-size:.7rem;white-space:nowrap}
      .lqs-library-empty{display:none;padding:35px 10px;text-align:center;color:var(--text-muted);font-size:.8rem}

      @media(min-width:860px){
        .lqs-sheet{left:auto;right:18px;bottom:18px;width:400px;border-radius:18px;border-bottom:1px solid var(--border)}
        #reader-word-panel.reader-word-panel.lqs-word-panel{left:auto!important;right:18px!important;bottom:18px!important;width:min(430px,calc(100vw - 36px))!important;border-radius:18px!important;max-height:calc(100vh - 36px)!important}
      }
    `;
    document.head.appendChild(style);
  }

  function createChrome(view) {
    if ($('.lqs-top', view)) return;
    const top = document.createElement('div');
    top.className = 'lqs-top';
    top.innerHTML = `
      <button class="lqs-button lqs-icon" data-lqs="back" aria-label="Библиотека">←</button>
      <div class="lqs-heading" data-lqs="toc"><div class="lqs-title">Reader AI</div><div class="lqs-subtitle">чтение</div></div>
      <div class="lqs-top-actions"><span class="lqs-counter">1/1</span><button class="lqs-button lqs-icon" data-lqs="search" aria-label="Поиск">⌕</button><button class="lqs-button lqs-icon" data-lqs="menu" aria-label="Меню">⋮</button></div>`;
    const bottom = document.createElement('div');
    bottom.className = 'lqs-bottom';
    bottom.innerHTML = `
      <div class="lqs-progress"><i></i></div>
      <div class="lqs-nav-grid">
        <button class="lqs-button lqs-nav" data-lqs="prev"><span>‹</span><small>назад</small></button>
        <button class="lqs-button lqs-nav" data-lqs="translate"><span>文</span><small>перевод</small></button>
        <button class="lqs-button lqs-nav primary" data-lqs="listen"><span>▶</span><small>слушать</small></button>
        <button class="lqs-button lqs-nav" data-lqs="sentence"><span>▤</span><small>предложения</small></button>
        <button class="lqs-button lqs-nav" data-lqs="next"><span>›</span><small>дальше</small></button>
      </div>`;
    view.prepend(top);
    view.append(bottom);
  }

  function createSheet() {
    if ($('#lqs-settings')) return;
    const back = document.createElement('div');
    back.id = 'lqs-settings-back';
    back.className = 'lqs-sheet-back';
    const sheet = document.createElement('div');
    sheet.id = 'lqs-settings';
    sheet.className = 'lqs-sheet';
    sheet.innerHTML = `
      <div class="lqs-grab"></div><div class="lqs-sheet-title">Чтение</div>
      <button class="lqs-menu-row" data-menu="sentence"><span class="lqs-menu-icon">▤</span><span class="lqs-menu-text"><b>Режим предложений</b><small>один фрагмент и быстрый разбор</small></span><i class="lqs-toggle"></i></button>
      <button class="lqs-menu-row" data-menu="marks"><span class="lqs-menu-icon">◩</span><span class="lqs-menu-text"><b>Подсветка слов</b><small>новые синие, изучаемые жёлтые</small></span><i class="lqs-toggle"></i></button>
      <button class="lqs-menu-row" data-menu="pages"><span class="lqs-menu-icon">📖</span><span class="lqs-menu-text"><b>Страницы / скролл</b><small>штатный режим Reader AI</small></span></button>
      <button class="lqs-menu-row" data-menu="display"><span class="lqs-menu-icon">Аа</span><span class="lqs-menu-text"><b>Текст и фон</b><small>шрифт, размер, тема и голос</small></span></button>
      <button class="lqs-menu-row" data-menu="pinyin"><span class="lqs-menu-icon">拼</span><span class="lqs-menu-text"><b>Пиньинь / чтение</b><small>для китайского и японского</small></span></button>
      <button class="lqs-menu-row" data-menu="audio"><span class="lqs-menu-icon">🎧</span><span class="lqs-menu-text"><b>Оригинальная запись</b><small>если прикреплена к книге</small></span></button>
      <button class="lqs-menu-row" data-menu="vocabulary"><span class="lqs-menu-icon">★</span><span class="lqs-menu-text"><b>Слова этой книги</b><small>просмотренные и сохранённые</small></span></button>
      <button class="lqs-menu-row" data-menu="analysis"><span class="lqs-menu-icon">🧩</span><span class="lqs-menu-text"><b>Разобрать фрагмент</b><small>грамматика Reader AI</small></span></button>`;
    document.body.append(back, sheet);
    back.addEventListener('click', closeSheet);
    sheet.addEventListener('click', onSheetAction);
  }

  function openSheet() { createSheet(); $('#lqs-settings-back')?.classList.add('open'); $('#lqs-settings')?.classList.add('open'); syncToggles(); }
  function closeSheet() { $('#lqs-settings-back')?.classList.remove('open'); $('#lqs-settings')?.classList.remove('open'); }

  function currentInfo() {
    const rows = $$('#reader-chapter-text .reader-paragraph');
    const active = $('#reader-chapter-text .reader-paragraph.active') || $('#reader-chapter-text .reader-paragraph.lqs-current') || rows[0];
    const position = Math.max(0, rows.indexOf(active));
    const dataIndex = Number(active?.dataset?.p);
    return { rows, active, position, index: Number.isFinite(dataIndex) ? dataIndex : position };
  }

  function sentenceModeEnabled() { return $('#reader-reading-view')?.classList.contains('lqs-sentence'); }
  function setSentenceMode(enabled) {
    const view = $('#reader-reading-view');
    if (!view) return;
    if (enabled && view.classList.contains('rd-pages-active')) invoke('readerTogglePagesMode');
    view.classList.toggle('lqs-sentence', enabled);
    writeFlag(SENTENCE_KEY, enabled);
    if (!enabled) $$('.reader-paragraph.lqs-current', view).forEach(row => row.classList.remove('lqs-current'));
    applySentenceMode();
    sync();
  }
  function toggleSentenceMode() { setSentenceMode(!sentenceModeEnabled()); }
  function applySentenceMode() {
    const view = $('#reader-reading-view');
    if (!view?.classList.contains('lqs-sentence')) return;
    const { rows, active } = currentInfo();
    rows.forEach(row => row.classList.toggle('lqs-current', row === active));
    active?.scrollIntoView({ block: 'start' });
  }

  function navigate(direction) {
    invoke(direction > 0 ? 'readerNextParagraph' : 'readerPrevParagraph');
    setTimeout(() => { applySentenceMode(); sync(); }, 20);
  }

  function handleAction(action) {
    const { index } = currentInfo();
    if (action === 'back') invoke('readerBackToLibrary');
    if (action === 'toc') invoke('readerOpenToc');
    if (action === 'search') invoke('readerToggleChapterSearch');
    if (action === 'menu') openSheet();
    if (action === 'prev') navigate(-1);
    if (action === 'next') navigate(1);
    if (action === 'translate') invoke('readerAction', null, 'translate', index);
    if (action === 'listen') invoke('readerListenToggle');
    if (action === 'sentence') toggleSentenceMode();
  }

  function onSheetAction(event) {
    const row = event.target.closest('[data-menu]');
    if (!row) return;
    const action = row.dataset.menu;
    const { index } = currentInfo();
    if (action === 'sentence') toggleSentenceMode();
    if (action === 'marks') invoke('readerToggleWordMarks');
    if (action === 'pages') invoke('readerTogglePagesMode');
    if (action === 'display') invoke('readerToggleDisplayPanel');
    if (action === 'pinyin') invoke('readerCycleZhPinyinMode');
    if (action === 'audio') invoke('readerToggleOriginalAudioPlayer');
    if (action === 'vocabulary') invoke('showReaderViewedWords');
    if (action === 'analysis') invoke('readerAction', null, 'analyze', index);
    if (!['sentence', 'marks'].includes(action)) closeSheet();
    setTimeout(sync, 20);
  }

  function syncToggles() {
    $('[data-menu="sentence"]')?.classList.toggle('on', sentenceModeEnabled());
    const marksButton = $('#reader-marks-btn');
    $('[data-menu="marks"]')?.classList.toggle('on', !!marksButton?.classList.contains('on'));
  }

  function decorateWordPanel() {
    const panel = $('#reader-word-panel');
    if (!panel || mountedPanels.has(panel)) return;
    mountedPanels.add(panel);
    panel.classList.add('lqs-word-panel');
    const states = document.createElement('div');
    states.className = 'lqs-word-states';
    states.innerHTML = `
      <button class="lqs-word-state" data-word-state="new">Новое</button>
      <button class="lqs-word-state study" data-word-state="study">Изучаю</button>
      <button class="lqs-word-state known" data-word-state="known">Знаю</button>
      <button class="lqs-word-state problem" data-word-state="problem">Трудное</button>`;
    const analysis = $('#reader-word-analysis', panel);
    panel.insertBefore(states, analysis || panel.firstChild);
    const arrows = document.createElement('div');
    arrows.className = 'lqs-word-arrows';
    arrows.innerHTML = '<button data-word-arrow="-1">← предыдущее</button><button data-word-arrow="1">следующее →</button>';
    panel.appendChild(arrows);
    panel.addEventListener('click', event => {
      const state = event.target.closest('[data-word-state]')?.dataset.wordState;
      if (state === 'new') invoke('readerCloseWordPanel');
      if (state === 'study') invoke('readerSaveWord');
      if (state === 'known') invoke('readerMarkSelectedWordKnown');
      if (state === 'problem') invoke('readerMarkSelectedWordProblem');
      const direction = Number(event.target.closest('[data-word-arrow]')?.dataset.wordArrow);
      if (direction) openAdjacentWord(direction);
    });
  }

  function openAdjacentWord(direction) {
    const words = $$('#reader-chapter-text .reader-word').filter(node => node.offsetParent !== null);
    if (!words.length) return;
    const selected = ($('#reader-word-title')?.textContent || '').trim();
    let index = words.findIndex(node => (node.dataset.word || node.textContent || '').trim() === selected);
    if (index < 0) index = 0;
    const next = words[(index + direction + words.length) % words.length];
    next?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    next?.click();
  }

  function enhanceLibrary() {
    const library = $('#reader-library-view');
    const list = $('#reader-library-list');
    if (!library || !list || $('.lqs-library-tools', library)) return;
    const tools = document.createElement('div');
    tools.className = 'lqs-library-tools';
    tools.innerHTML = '<input class="lqs-library-search" type="search" placeholder="Поиск по библиотеке"><span class="lqs-library-count">0 текстов</span>';
    const empty = document.createElement('div');
    empty.className = 'lqs-library-empty';
    empty.textContent = 'Ничего не найдено';
    list.before(tools); list.after(empty);
    $('.lqs-library-search', tools)?.addEventListener('input', event => filterLibrary(event.target.value));
    filterLibrary('');
  }

  function filterLibrary(value) {
    const list = $('#reader-library-list');
    if (!list) return;
    const query = String(value || '').trim().toLocaleLowerCase();
    const cards = [...list.children].filter(node => node.nodeType === 1);
    let visible = 0;
    cards.forEach(card => {
      const show = !query || String(card.textContent || '').toLocaleLowerCase().includes(query);
      card.style.display = show ? '' : 'none';
      if (show) visible += 1;
    });
    const count = $('.lqs-library-count');
    if (count) count.textContent = `${visible} ${visible === 1 ? 'текст' : visible > 1 && visible < 5 ? 'текста' : 'текстов'}`;
    const empty = $('.lqs-library-empty');
    if (empty) empty.style.display = cards.length && !visible ? 'block' : 'none';
  }

  function mount() {
    const view = $('#reader-reading-view');
    if (!view) return false;
    installStyles(); createChrome(view); createSheet();
    view.classList.add('lqs-active');
    view.classList.toggle('lqs-sentence', readFlag(SENTENCE_KEY, false));
    if (!view.dataset.lqsBound) {
      view.dataset.lqsBound = '1';
      view.addEventListener('click', event => {
        const action = event.target.closest('[data-lqs]')?.dataset.lqs;
        if (action) handleAction(action);
      });
    }
    decorateWordPanel(); enhanceLibrary(); observe(view); sync();
    return true;
  }

  function observe(view) {
    if (observer) return;
    observer = new MutationObserver(() => scheduleSync());
    observer.observe(view, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 35); }

  function sync() {
    const view = $('#reader-reading-view');
    if (!view) return;
    if (!view.classList.contains('lqs-active')) mount();
    const { rows, position } = currentInfo();
    const title = ($('#reader-book-title')?.textContent || 'Reader AI').trim();
    const subtitle = ($('#reader-chapter-title')?.textContent || 'чтение').trim();
    const titleNode = $('.lqs-title', view); if (titleNode && titleNode.textContent !== title) titleNode.textContent = title;
    const subtitleNode = $('.lqs-subtitle', view); if (subtitleNode && subtitleNode.textContent !== subtitle) subtitleNode.textContent = subtitle;
    const counter = $('.lqs-counter', view); if (counter) counter.textContent = `${Math.min(position + 1, Math.max(1, rows.length))}/${Math.max(1, rows.length)}`;
    const source = $('#reader-progress-bar');
    let progress = Number.parseFloat(source?.style.width || '');
    if (!Number.isFinite(progress)) progress = rows.length ? ((position + 1) / rows.length) * 100 : 0;
    const fill = $('.lqs-progress>i', view); if (fill) fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    $('.lqs-nav[data-lqs="sentence"]', view)?.classList.toggle('on', sentenceModeEnabled());
    const label = $('.lqs-nav[data-lqs="sentence"] small', view); if (label) label.textContent = sentenceModeEnabled() ? 'весь текст' : 'предложения';
    applySentenceMode(); decorateWordPanel(); enhanceLibrary(); syncToggles();
  }

  function bindKeyboard() {
    document.addEventListener('keydown', event => {
      const view = $('#reader-reading-view');
      if (!view || view.style.display === 'none' || event.target?.matches?.('input,textarea,select')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
      if (event.key === ' ') { event.preventDefault(); invoke('readerListenToggle'); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); toggleSentenceMode(); }
      if (event.key === 'Escape') { closeSheet(); invoke('readerCloseWordPanel'); }
    });
  }

  function boot() {
    installStyles(); bindKeyboard(); enhanceLibrary(); mount();
    const retry = setInterval(() => { enhanceLibrary(); mount(); decorateWordPanel(); }, 300);
    setTimeout(() => clearInterval(retry), 20000);
    console.info(`[lingq-shell] v${VERSION} loaded`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

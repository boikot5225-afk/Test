/* Reader AI — LingQ-style shell v0.3.
 * This module changes only presentation and navigation. Reader AI owns data,
 * dictionaries, AI calls, audio, EPUB parsing, storage and word state.
 */
(() => {
  'use strict';

  const SENTENCE_KEY = 'reader_ai_lingq_sentence_mode_v1';
  const decoratedPanels = new WeakSet();
  let intervalId = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const sameText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  const invoke = (name, ...args) => {
    const fn = window[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); }
    catch (error) {
      console.error(`[lingq-shell] ${name}`, error);
      window.showToast?.(`⚠️ ${error?.message || error}`);
      return undefined;
    }
  };
  const loadSentenceMode = () => { try { return localStorage.getItem(SENTENCE_KEY) === '1'; } catch { return false; } };
  const saveSentenceMode = value => { try { localStorage.setItem(SENTENCE_KEY, value ? '1' : '0'); } catch {} };
  const readerIsOpen = view => !!view && view.style.display !== 'none';

  function injectStyles() {
    if ($('#lingq-shell-v2-style')) return;
    const style = document.createElement('style');
    style.id = 'lingq-shell-v2-style';
    style.textContent = `
      :root{--lq-green:#18a566;--lq-green-soft:rgba(24,165,102,.14);--lq-blue-soft:rgba(36,139,210,.19);--lq-yellow-soft:rgba(229,188,55,.24)}
      #reader-reading-view.lqv2{position:fixed!important;inset:0!important;z-index:620!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;padding:0!important;background:var(--bg)!important}
      #reader-reading-view.lqv2>.rd-top,#reader-reading-view.lqv2>.rd-bot,#reader-reading-view.lqv2>.rd-free-prog{display:none!important}
      #reader-reading-view.lqv2>.rd-scroll{position:relative!important;inset:auto!important;flex:1 1 auto!important;min-height:0!important;overflow:auto!important;padding:18px max(18px,env(safe-area-inset-right)) calc(104px + env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))!important;scroll-padding-top:82px!important;background:var(--bg)!important}
      #reader-reading-view.lqv2 #reader-chapter-text{width:min(790px,100%)!important;margin:0 auto!important}
      #reader-reading-view.lqv2 .reader-paragraph{padding:8px 7px;border-radius:11px;margin-bottom:3px;transition:background .15s ease}
      #reader-reading-view.lqv2 .reader-paragraph.active{background:var(--lq-green-soft)}
      #reader-reading-view.lqv2 .reader-word{padding:0 1px;border-radius:3px;text-decoration:none!important;box-decoration-break:clone;-webkit-box-decoration-break:clone}
      #reader-reading-view.lqv2 .reader-word.rw-new,#reader-reading-view.lqv2 .reader-word.rw-looked,#reader-reading-view.lqv2 .reader-word.rw-seen{background:var(--lq-blue-soft)!important;box-shadow:inset 0 -2px rgba(36,139,210,.45)}
      #reader-reading-view.lqv2 .reader-word.rw-learning,#reader-reading-view.lqv2 .reader-word.rw-saved,#reader-reading-view.lqv2 .reader-word.rw-problem{background:var(--lq-yellow-soft)!important;box-shadow:inset 0 -2px rgba(229,188,55,.56)}
      #reader-reading-view.lqv2 .reader-word.rw-known,#reader-reading-view.lqv2 .reader-word.rw-familiar,#reader-reading-view.lqv2 .reader-word.rw-faded{background:transparent!important;box-shadow:none!important}
      .lqv2-top{flex:none;z-index:30;min-height:58px;display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:6px;padding:max(7px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) 7px max(8px,env(safe-area-inset-left));background:color-mix(in srgb,var(--surface) 95%,transparent);border-bottom:1px solid var(--border);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
      .lqv2-btn{appearance:none;border:0;background:transparent;color:var(--text);font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
      .lqv2-icon{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:1.04rem}.lqv2-icon:active,.lqv2-nav:active,.lqv2-row:active{background:rgba(127,127,127,.17)}
      .lqv2-heading{min-width:0;cursor:pointer}.lqv2-title{font-size:.88rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lqv2-sub{margin-top:2px;color:var(--text-muted);font-size:.67rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .lqv2-actions{display:flex;align-items:center}.lqv2-count{min-width:35px;padding:5px 8px;border:1px solid var(--border);border-radius:16px;color:var(--text-muted);font-size:.67rem;text-align:center;font-variant-numeric:tabular-nums}
      .lqv2-bottom{position:absolute;left:0;right:0;bottom:0;z-index:31;padding:5px max(9px,env(safe-area-inset-right)) max(7px,env(safe-area-inset-bottom)) max(9px,env(safe-area-inset-left));background:color-mix(in srgb,var(--surface) 96%,transparent);border-top:1px solid var(--border);backdrop-filter:blur(15px);-webkit-backdrop-filter:blur(15px)}
      .lqv2-progress{height:3px;margin:0 4px 5px;background:rgba(127,127,127,.25);border-radius:4px;overflow:hidden}.lqv2-progress i{display:block;height:100%;width:0;background:var(--lq-green);transition:width .16s ease}
      .lqv2-grid{display:grid;grid-template-columns:1fr 1fr 1.18fr 1fr 1fr;gap:2px}.lqv2-nav{min-height:48px;border-radius:11px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:1.02rem}.lqv2-nav small{font-size:.59rem;color:var(--text-muted);font-weight:500}.lqv2-nav.primary{min-height:45px;margin:0 4px;border-radius:24px;background:var(--lq-green);color:#fff}.lqv2-nav.on{background:var(--lq-green-soft);color:var(--lq-green)}
      .lqv2-backdrop{position:fixed;inset:0;z-index:798;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .18s}.lqv2-backdrop.open{opacity:1;pointer-events:auto}
      .lqv2-sheet{position:fixed;left:0;right:0;bottom:0;z-index:799;max-height:min(80vh,680px);overflow:auto;padding:9px 14px calc(17px + env(safe-area-inset-bottom));background:var(--surface);color:var(--text);border:1px solid var(--border);border-bottom:0;border-radius:22px 22px 0 0;box-shadow:0 -18px 50px rgba(0,0,0,.36);transform:translateY(104%);transition:transform .21s ease}.lqv2-sheet.open{transform:translateY(0)}
      .lqv2-grab{width:38px;height:4px;border-radius:4px;background:rgba(127,127,127,.44);margin:0 auto 13px}.lqv2-sheet-title{font-weight:700;margin:0 5px 9px}
      .lqv2-row{width:100%;min-height:51px;border:0;border-radius:12px;background:transparent;color:inherit;display:flex;align-items:center;gap:12px;padding:9px 10px;text-align:left;font:inherit;cursor:pointer}.lqv2-row-icon{width:31px;height:31px;border-radius:9px;background:rgba(127,127,127,.13);display:grid;place-items:center;flex:none}.lqv2-row-text{min-width:0;flex:1}.lqv2-row-text b{display:block;font-size:.84rem}.lqv2-row-text small{display:block;margin-top:2px;color:var(--text-muted);font-size:.66rem}
      .lqv2-toggle{width:42px;height:24px;border-radius:13px;background:rgba(127,127,127,.34);position:relative;flex:none}.lqv2-toggle:after{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:#fff;transition:transform .15s}.lqv2-row.on .lqv2-toggle{background:var(--lq-green)}.lqv2-row.on .lqv2-toggle:after{transform:translateX(18px)}
      #reader-reading-view.lqv2-sentence .reader-paragraph{display:none!important}#reader-reading-view.lqv2-sentence .reader-paragraph.lqv2-current{display:block!important;min-height:calc(100dvh - 224px);padding:24px 15px!important;margin:0 auto!important;background:transparent!important;font-size:1.12em;line-height:1.9}#reader-reading-view.lqv2-sentence>.rd-scroll{padding-top:22px!important}
      #reader-word-panel.reader-word-panel.lqv2-word-panel{z-index:810!important;max-height:min(80vh,730px)!important;border-radius:22px 22px 0 0!important;padding-bottom:calc(15px + env(safe-area-inset-bottom))!important}
      .lqv2-word-states{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 11px}.lqv2-word-state{border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);padding:9px 3px;font:inherit;font-size:.68rem;font-weight:650;cursor:pointer}.lqv2-word-state.study{background:var(--lq-yellow-soft)}.lqv2-word-state.known{background:var(--lq-green-soft)}.lqv2-word-state.problem{background:rgba(205,65,65,.14)}
      .lqv2-word-arrows{display:flex;gap:7px;margin-top:10px}.lqv2-word-arrows button{flex:1;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);padding:9px;font:inherit;font-size:.72rem;cursor:pointer}
      .lqv2-library-tools{display:grid;grid-template-columns:1fr auto;gap:8px;margin:8px 0 14px}.lqv2-library-search{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--border);border-radius:12px;background:var(--surface2);color:var(--text);font:inherit;outline:none}.lqv2-library-count{display:flex;align-items:center;padding:0 11px;border:1px solid var(--border);border-radius:12px;color:var(--text-muted);font-size:.7rem;white-space:nowrap}.lqv2-library-empty{display:none;padding:35px 10px;text-align:center;color:var(--text-muted);font-size:.8rem}
      @media(min-width:860px){.lqv2-sheet{left:auto;right:18px;bottom:18px;width:400px;border-radius:18px;border-bottom:1px solid var(--border)}#reader-word-panel.reader-word-panel.lqv2-word-panel{left:auto!important;right:18px!important;bottom:18px!important;width:min(430px,calc(100vw - 36px))!important;border-radius:18px!important;max-height:calc(100vh - 36px)!important}}
    `;
    document.head.appendChild(style);
  }

  function ensureChrome(view) {
    if (!$('.lqv2-top', view)) {
      const top = document.createElement('div');
      top.className = 'lqv2-top';
      top.innerHTML = `<button class="lqv2-btn lqv2-icon" data-lqv2="back">←</button><div class="lqv2-heading" data-lqv2="toc"><div class="lqv2-title">Reader AI</div><div class="lqv2-sub">чтение</div></div><div class="lqv2-actions"><span class="lqv2-count">1/1</span><button class="lqv2-btn lqv2-icon" data-lqv2="search">⌕</button><button class="lqv2-btn lqv2-icon" data-lqv2="menu">⋮</button></div>`;
      view.prepend(top);
    }
    if (!$('.lqv2-bottom', view)) {
      const bottom = document.createElement('div');
      bottom.className = 'lqv2-bottom';
      bottom.innerHTML = `<div class="lqv2-progress"><i></i></div><div class="lqv2-grid"><button class="lqv2-btn lqv2-nav" data-lqv2="prev"><span>‹</span><small>назад</small></button><button class="lqv2-btn lqv2-nav" data-lqv2="translate"><span>文</span><small>перевод</small></button><button class="lqv2-btn lqv2-nav primary" data-lqv2="listen"><span>▶</span><small>слушать</small></button><button class="lqv2-btn lqv2-nav" data-lqv2="sentence"><span>▤</span><small>предложения</small></button><button class="lqv2-btn lqv2-nav" data-lqv2="next"><span>›</span><small>дальше</small></button></div>`;
      view.append(bottom);
    }
    if (!view.dataset.lqv2Bound) {
      view.dataset.lqv2Bound = '1';
      view.addEventListener('click', event => {
        const action = event.target.closest('[data-lqv2]')?.dataset.lqv2;
        if (action) handleAction(action);
      });
    }
  }

  function ensureSheet() {
    if ($('#lqv2-sheet')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'lqv2-backdrop'; backdrop.className = 'lqv2-backdrop';
    const sheet = document.createElement('div');
    sheet.id = 'lqv2-sheet'; sheet.className = 'lqv2-sheet';
    sheet.innerHTML = `<div class="lqv2-grab"></div><div class="lqv2-sheet-title">Чтение</div>
      <button class="lqv2-row" data-lqv2-menu="sentence"><span class="lqv2-row-icon">▤</span><span class="lqv2-row-text"><b>Режим предложений</b><small>один фрагмент и быстрый разбор</small></span><i class="lqv2-toggle"></i></button>
      <button class="lqv2-row" data-lqv2-menu="marks"><span class="lqv2-row-icon">◩</span><span class="lqv2-row-text"><b>Подсветка слов</b><small>новые синие, изучаемые жёлтые</small></span><i class="lqv2-toggle"></i></button>
      <button class="lqv2-row" data-lqv2-menu="pages"><span class="lqv2-row-icon">📖</span><span class="lqv2-row-text"><b>Страницы / скролл</b><small>штатное листание Reader AI</small></span></button>
      <button class="lqv2-row" data-lqv2-menu="display"><span class="lqv2-row-icon">Аа</span><span class="lqv2-row-text"><b>Текст, фон и голос</b><small>все настройки чтения</small></span></button>
      <button class="lqv2-row" data-lqv2-menu="reading"><span class="lqv2-row-icon">拼</span><span class="lqv2-row-text"><b>Пиньинь / чтение</b><small>подписи для иероглифов</small></span></button>
      <button class="lqv2-row" data-lqv2-menu="audio"><span class="lqv2-row-icon">🎧</span><span class="lqv2-row-text"><b>Оригинальная запись</b><small>если прикреплена к книге</small></span></button>
      <button class="lqv2-row" data-lqv2-menu="words"><span class="lqv2-row-icon">★</span><span class="lqv2-row-text"><b>Слова этой книги</b><small>просмотренные и сохранённые</small></span></button>
      <button class="lqv2-row" data-lqv2-menu="analysis"><span class="lqv2-row-icon">🧩</span><span class="lqv2-row-text"><b>Разобрать фрагмент</b><small>грамматика Reader AI</small></span></button>`;
    document.body.append(backdrop, sheet);
    backdrop.addEventListener('click', closeSheet);
    sheet.addEventListener('click', event => {
      const action = event.target.closest('[data-lqv2-menu]')?.dataset.lqv2Menu;
      if (!action) return;
      const { index } = currentParagraph();
      if (action === 'sentence') setSentenceMode(!sentenceMode());
      if (action === 'marks') invoke('readerToggleWordMarks');
      if (action === 'pages') invoke('readerTogglePagesMode');
      if (action === 'display') invoke('readerToggleDisplayPanel');
      if (action === 'reading') invoke('readerCycleZhPinyinMode');
      if (action === 'audio') invoke('readerToggleOriginalAudioPlayer');
      if (action === 'words') invoke('showReaderViewedWords');
      if (action === 'analysis') invoke('readerAction', null, 'analyze', index);
      if (!['sentence','marks'].includes(action)) closeSheet();
      setTimeout(sync, 25);
    });
  }

  function openSheet() { ensureSheet(); $('#lqv2-backdrop')?.classList.add('open'); $('#lqv2-sheet')?.classList.add('open'); syncToggles(); }
  function closeSheet() { $('#lqv2-backdrop')?.classList.remove('open'); $('#lqv2-sheet')?.classList.remove('open'); }
  function sentenceMode() { return $('#reader-reading-view')?.classList.contains('lqv2-sentence'); }

  function currentParagraph() {
    const rows = $$('#reader-chapter-text .reader-paragraph');
    const active = $('#reader-chapter-text .reader-paragraph.active') || $('#reader-chapter-text .reader-paragraph.lqv2-current') || rows[0];
    const position = Math.max(0, rows.indexOf(active));
    const value = Number(active?.dataset?.p);
    return { rows, active, position, index: Number.isFinite(value) ? value : position };
  }

  function applySentenceMode() {
    const view = $('#reader-reading-view');
    if (!readerIsOpen(view) || !sentenceMode()) return;
    const { rows, active } = currentParagraph();
    rows.forEach(row => row.classList.toggle('lqv2-current', row === active));
  }

  function setSentenceMode(enabled) {
    const view = $('#reader-reading-view');
    if (!view) return;
    if (enabled && view.classList.contains('rd-pages-active')) invoke('readerTogglePagesMode');
    view.classList.toggle('lqv2-sentence', enabled);
    saveSentenceMode(enabled);
    if (!enabled) $$('.reader-paragraph.lqv2-current', view).forEach(row => row.classList.remove('lqv2-current'));
    applySentenceMode(); sync();
  }

  function navigate(delta) {
    invoke(delta > 0 ? 'readerNextParagraph' : 'readerPrevParagraph');
    setTimeout(() => { applySentenceMode(); sync(); }, 25);
  }

  function handleAction(action) {
    const { index } = currentParagraph();
    if (action === 'back') invoke('readerBackToLibrary');
    if (action === 'toc') invoke('readerOpenToc');
    if (action === 'search') invoke('readerToggleChapterSearch');
    if (action === 'menu') openSheet();
    if (action === 'prev') navigate(-1);
    if (action === 'next') navigate(1);
    if (action === 'translate') invoke('readerAction', null, 'translate', index);
    if (action === 'listen') invoke('readerListenToggle');
    if (action === 'sentence') setSentenceMode(!sentenceMode());
  }

  function decorateWordPanel() {
    const panel = $('#reader-word-panel');
    if (!panel || decoratedPanels.has(panel)) return;
    decoratedPanels.add(panel); panel.classList.add('lqv2-word-panel');
    const states = document.createElement('div');
    states.className = 'lqv2-word-states';
    states.innerHTML = `<button class="lqv2-word-state" data-lqv2-state="new">Новое</button><button class="lqv2-word-state study" data-lqv2-state="study">Изучаю</button><button class="lqv2-word-state known" data-lqv2-state="known">Знаю</button><button class="lqv2-word-state problem" data-lqv2-state="problem">Трудное</button>`;
    const analysis = $('#reader-word-analysis', panel); panel.insertBefore(states, analysis || panel.firstChild);
    const arrows = document.createElement('div'); arrows.className = 'lqv2-word-arrows'; arrows.innerHTML = '<button data-lqv2-arrow="-1">← предыдущее</button><button data-lqv2-arrow="1">следующее →</button>'; panel.appendChild(arrows);
    panel.addEventListener('click', event => {
      const state = event.target.closest('[data-lqv2-state]')?.dataset.lqv2State;
      if (state === 'new') invoke('readerCloseWordPanel');
      if (state === 'study') invoke('readerSaveWord');
      if (state === 'known') invoke('readerMarkSelectedWordKnown');
      if (state === 'problem') invoke('readerMarkSelectedWordProblem');
      const direction = Number(event.target.closest('[data-lqv2-arrow]')?.dataset.lqv2Arrow);
      if (direction) openAdjacentWord(direction);
    });
  }

  function openAdjacentWord(direction) {
    const words = $$('#reader-chapter-text .reader-word').filter(node => node.offsetParent !== null);
    if (!words.length) return;
    const selected = ($('#reader-word-title')?.textContent || '').trim();
    let index = words.findIndex(node => (node.dataset.word || node.textContent || '').trim() === selected);
    if (index < 0) index = 0;
    const target = words[(index + direction + words.length) % words.length];
    target?.scrollIntoView({ block:'center', behavior:'smooth' }); target?.click();
  }

  function enhanceLibrary() {
    const library = $('#reader-library-view'), list = $('#reader-library-list');
    if (!library || !list || $('.lqv2-library-tools', library)) return;
    const tools = document.createElement('div'); tools.className = 'lqv2-library-tools'; tools.innerHTML = '<input class="lqv2-library-search" type="search" placeholder="Поиск по библиотеке"><span class="lqv2-library-count">0 текстов</span>';
    const empty = document.createElement('div'); empty.className = 'lqv2-library-empty'; empty.textContent = 'Ничего не найдено';
    list.before(tools); list.after(empty);
    $('.lqv2-library-search', tools)?.addEventListener('input', event => filterLibrary(event.target.value)); filterLibrary('');
  }

  function filterLibrary(value) {
    const list = $('#reader-library-list'); if (!list) return;
    const query = String(value || '').trim().toLocaleLowerCase(); const cards = [...list.children].filter(node => node.nodeType === 1); let visible = 0;
    cards.forEach(card => { const show = !query || String(card.textContent || '').toLocaleLowerCase().includes(query); card.style.display = show ? '' : 'none'; if (show) visible += 1; });
    sameText($('.lqv2-library-count'), `${visible} ${visible === 1 ? 'текст' : visible > 1 && visible < 5 ? 'текста' : 'текстов'}`);
    const empty = $('.lqv2-library-empty'); if (empty) empty.style.display = cards.length && !visible ? 'block' : 'none';
  }

  function syncToggles() {
    $('[data-lqv2-menu="sentence"]')?.classList.toggle('on', sentenceMode());
    $('[data-lqv2-menu="marks"]')?.classList.toggle('on', !!$('#reader-marks-btn')?.classList.contains('on'));
  }

  function sync() {
    const view = $('#reader-reading-view'); if (!view) return;
    ensureChrome(view); ensureSheet(); enhanceLibrary(); decorateWordPanel();
    const open = readerIsOpen(view); view.classList.toggle('lqv2', open);
    if (!open) { view.classList.remove('lqv2-sentence'); return; }
    view.classList.toggle('lqv2-sentence', loadSentenceMode());
    const { rows, position } = currentParagraph();
    sameText($('.lqv2-title', view), ($('#reader-book-title')?.textContent || 'Reader AI').trim());
    sameText($('.lqv2-sub', view), ($('#reader-chapter-title')?.textContent || 'чтение').trim());
    sameText($('.lqv2-count', view), `${Math.min(position + 1, Math.max(1, rows.length))}/${Math.max(1, rows.length)}`);
    let progress = Number.parseFloat($('#reader-progress-bar')?.style.width || ''); if (!Number.isFinite(progress)) progress = rows.length ? ((position + 1) / rows.length) * 100 : 0;
    const fill = $('.lqv2-progress i', view), width = `${Math.max(0, Math.min(100, progress))}%`; if (fill && fill.style.width !== width) fill.style.width = width;
    const sentenceButton = $('.lqv2-nav[data-lqv2="sentence"]', view); sentenceButton?.classList.toggle('on', sentenceMode());
    sameText($('small', sentenceButton || document), sentenceMode() ? 'весь текст' : 'предложения');
    applySentenceMode(); syncToggles();
  }

  function bindKeyboard() {
    document.addEventListener('keydown', event => {
      const view = $('#reader-reading-view'); if (!readerIsOpen(view) || event.target?.matches?.('input,textarea,select')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
      if (event.key === ' ') { event.preventDefault(); invoke('readerListenToggle'); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); setSentenceMode(!sentenceMode()); }
      if (event.key === 'Escape') { closeSheet(); invoke('readerCloseWordPanel'); }
    });
  }

  function boot() {
    injectStyles(); ensureSheet(); enhanceLibrary(); bindKeyboard(); sync();
    intervalId = window.setInterval(sync, 350);
    window.addEventListener('pagehide', () => clearInterval(intervalId), { once:true });
    console.info('[lingq-shell] v0.3.0 loaded');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true }); else boot();
})();

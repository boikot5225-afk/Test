/* LingQ-style chapter completion for Reader AI v0.5.
 * Loaded after the sentence/book-vocabulary layer. It intercepts only the
 * final "next" action of a chapter and leaves Reader AI navigation untouched
 * everywhere else.
 */
(() => {
  'use strict';

  const VERSION = '0.5.0';
  const state = { api: null, apiPromise: null, rows: [], filter: 'all', chapterIndex: 0 };
  const $ = (selector, root = document) => root?.querySelector?.(selector) || null;
  const $$ = (selector, root = document) => [...(root?.querySelectorAll?.(selector) || [])];
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function api() {
    if (state.api) return state.api;
    if (window.__lqReaderApiOverride) return (state.api = window.__lqReaderApiOverride);
    if (!state.apiPromise) {
      state.apiPromise = import('./reader-app.js?v=77.32')
        .then(module => (state.api = module))
        .catch(error => { console.warn('[lingq completion] Reader API unavailable:', error); return null; });
    }
    return state.apiPromise;
  }

  function contentText(item) {
    if (item == null || item?.type === 'image') return '';
    if (typeof item === 'string') return item;
    if (Array.isArray(item.runs)) return item.runs.map(run => String(run?.text || '')).join('');
    return typeof item.text === 'string' ? item.text : '';
  }

  function statusOf(wordState) {
    const status = String(wordState?.status || '').toLowerCase();
    if (wordState?.known || status === 'known') return 'known';
    if (status === 'problem' || status === 'hard') return 'problem';
    if (wordState?.saved || status === 'learning' || status === 'familiar') return 'learning';
    if (status === 'looked' || Number(wordState?.clicked || 0) > 0) return 'looked';
    return 'new';
  }

  const statusLabel = status => ({
    new: 'новое', looked: 'просмотрено', learning: 'изучаю', known: 'знаю', problem: 'трудное',
  }[status] || status);

  function sentenceIsLast() {
    const raw = clean($('[data-lqf4-count]')?.textContent);
    const match = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
    return !!match && Number(match[1]) >= Number(match[2]);
  }

  function chapterIsAtLastParagraph(book) {
    const chapter = book?.chapters?.[book.currentChapter || 0];
    if (!chapter) return false;
    const readable = [];
    (chapter.paragraphs || []).forEach((item, index) => {
      if (clean(contentText(item))) readable.push(index);
    });
    return !!readable.length && Number(book.currentParagraph || 0) === readable[readable.length - 1];
  }

  function shouldComplete() {
    const view = $('#reader-reading-view');
    if (!view?.classList.contains('lqv2-sentence') || view.style.display === 'none') return false;
    const book = state.api?.readerCurrentBook?.();
    return !!book && sentenceIsLast() && chapterIsAtLastParagraph(book);
  }

  function injectStyles() {
    if ($('#lingq-completion-v5-style')) return;
    const style = document.createElement('style');
    style.id = 'lingq-completion-v5-style';
    style.textContent = `
      .lqc5-back{position:fixed;inset:0;z-index:840;display:none;background:rgba(0,0,0,.64)}.lqc5-back.open{display:block}
      .lqc5-panel{position:fixed;left:0;right:0;bottom:0;z-index:841;display:none;max-height:min(88vh,760px);overflow:auto;padding:10px 15px calc(20px + env(safe-area-inset-bottom));border:1px solid var(--border);border-bottom:0;border-radius:23px 23px 0 0;background:var(--surface);color:var(--text);box-shadow:0 -22px 70px rgba(0,0,0,.45)}.lqc5-panel.open{display:block}
      .lqc5-grab{width:38px;height:4px;margin:0 auto 13px;border-radius:4px;background:rgba(127,127,127,.45)}
      .lqc5-panel h2{margin:2px 0 5px;font:600 1.38rem/1.25 'Lora','Noto Serif SC',serif}.lqc5-sub{color:var(--text-muted);font-size:.74rem;margin-bottom:13px}
      .lqc5-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:12px 0}.lqc5-stat{padding:11px 6px;border:1px solid var(--border);border-radius:12px;text-align:center;background:var(--bg)}.lqc5-stat b{display:block;font-size:1.13rem}.lqc5-stat small{display:block;margin-top:3px;color:var(--text-muted);font-size:.61rem}
      .lqc5-rating{margin:15px 0}.lqc5-label{margin-bottom:8px;color:var(--text-muted);font-size:.69rem}.lqc5-rating-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.lqc5-rating-grid button{padding:9px 3px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text);font:inherit;cursor:pointer}.lqc5-rating-grid button.on{border-color:#18a566;background:rgba(24,165,102,.14);color:#18a566}
      .lqc5-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:13px}.lqc5-actions button{min-height:44px;padding:9px;border:1px solid var(--border);border-radius:11px;background:var(--bg);color:var(--text);font:inherit;font-size:.75rem;cursor:pointer}.lqc5-actions button.primary{grid-column:1/-1;border-color:#18a566;background:#18a566;color:white;font-weight:650}
      .lqc5-vocab{display:none;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}.lqc5-vocab.open{display:block}.lqc5-tabs{display:flex;gap:6px;overflow:auto;margin-bottom:8px;scrollbar-width:none}.lqc5-tab{flex:none;padding:6px 10px;border:1px solid var(--border);border-radius:15px;background:transparent;color:var(--text-muted);font:inherit;font-size:.67rem;cursor:pointer}.lqc5-tab.on{border-color:#18a566;background:rgba(24,165,102,.14);color:#18a566}
      .lqc5-list{max-height:37vh;overflow:auto;border:1px solid var(--border);border-radius:12px}.lqc5-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 72%,transparent);cursor:pointer}.lqc5-row:last-child{border-bottom:0}.lqc5-word{font-family:'Lora','Noto Serif SC',serif;font-size:1rem}.lqc5-meta{margin-top:3px;color:var(--text-muted);font-size:.65rem}.lqc5-state{padding:5px 8px;border-radius:12px;background:rgba(36,139,210,.19);font-size:.63rem;white-space:nowrap}.lqc5-state.learning{background:rgba(229,188,55,.24)}.lqc5-state.known{background:rgba(24,165,102,.14)}.lqc5-state.problem{background:rgba(205,65,65,.14)}.lqc5-empty{padding:25px;text-align:center;color:var(--text-muted);font-size:.76rem}
      @media(min-width:860px){.lqc5-panel{left:50%;right:auto;bottom:24px;width:min(540px,calc(100vw - 40px));transform:translateX(-50%);border-radius:20px;border-bottom:1px solid var(--border)}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    if ($('#lqc5-panel')) return;
    const back = document.createElement('div');
    back.id = 'lqc5-back'; back.className = 'lqc5-back';
    const panel = document.createElement('section');
    panel.id = 'lqc5-panel'; panel.className = 'lqc5-panel';
    panel.innerHTML = `<div class="lqc5-grab"></div><h2>Глава прочитана</h2><div class="lqc5-sub"></div><div class="lqc5-stats"></div><div class="lqc5-rating"><div class="lqc5-label">Насколько понятна глава?</div><div class="lqc5-rating-grid">${[1,2,3,4,5].map(score => `<button data-lqc5-rating="${score}">${score}</button>`).join('')}</div></div><div class="lqc5-actions"><button data-lqc5-action="words">★ Слова главы</button><button data-lqc5-action="known">✓ Новые → знаю</button><button class="primary" data-lqc5-action="continue">Следующая глава →</button></div><div class="lqc5-vocab"><div class="lqc5-tabs"><button class="lqc5-tab on" data-lqc5-filter="all">Все</button><button class="lqc5-tab" data-lqc5-filter="new">Новые</button><button class="lqc5-tab" data-lqc5-filter="learning">Изучаю</button><button class="lqc5-tab" data-lqc5-filter="known">Знаю</button><button class="lqc5-tab" data-lqc5-filter="problem">Трудные</button></div><div class="lqc5-list"></div></div>`;
    document.body.append(back, panel);
    back.addEventListener('click', closePanel);
    panel.addEventListener('click', async event => {
      const rating = Number(event.target.closest('[data-lqc5-rating]')?.dataset.lqc5Rating);
      if (rating) setRating(rating);
      const filter = event.target.closest('[data-lqc5-filter]')?.dataset.lqc5Filter;
      if (filter) { state.filter = filter; renderWords(); }
      const action = event.target.closest('[data-lqc5-action]')?.dataset.lqc5Action;
      if (action === 'words') { $('.lqc5-vocab', panel)?.classList.toggle('open'); renderWords(); }
      if (action === 'known') await markNewKnown();
      if (action === 'continue') await continueReading();
      const row = event.target.closest('[data-lqc5-word]');
      if (row) await openWordContext(row.dataset.lqc5Word);
    });
  }

  async function buildChapterRows() {
    const mod = await api(), book = mod?.readerCurrentBook?.();
    if (!mod || !book) return [];
    const chapterIndex = Number(book.currentChapter || 0);
    const chapter = book.chapters?.[chapterIndex];
    const lang = mod.readerBookLang?.(book) || globalThis.AN2_LANG || 'en';
    const store = mod.loadReaderWordState?.() || {};
    const map = new Map();
    let order = 0;
    (chapter?.paragraphs || []).forEach((paragraph, paragraphIndex) => {
      const text = contentText(paragraph);
      for (const surface of mod.readerTokenizeParagraph?.(text, lang) || []) {
        const word = mod.readerNormalizeWord?.(surface, lang) || clean(surface).toLocaleLowerCase();
        if (!word || !/[\p{L}\p{N}一-鿿ぁ-ヿ]/u.test(word)) continue;
        let item = map.get(word);
        if (!item) {
          const key = mod.readerWordStateKey?.(word, lang);
          const wordState = key ? store[key] : mod.readerGetWordState?.(word, lang);
          item = { word, surface: String(surface || word), status: statusOf(wordState), wordState, frequency: 0, order: order++, occurrences: [] };
          map.set(word, item);
        }
        item.frequency += 1;
        if (item.occurrences.length < 10) item.occurrences.push({ paragraphIndex, surface: String(surface || word) });
      }
    });
    state.chapterIndex = chapterIndex;
    state.rows = [...map.values()];
    return state.rows;
  }

  function counts() {
    return state.rows.reduce((out, item) => {
      out[item.status] = (out[item.status] || 0) + 1;
      return out;
    }, {});
  }

  async function openPanel() {
    ensurePanel();
    const mod = await api(), book = mod?.readerCurrentBook?.();
    if (!mod || !book) return;
    await buildChapterRows();
    const chapterIndex = Number(book.currentChapter || 0);
    const chapter = book.chapters?.[chapterIndex];
    const last = chapterIndex >= (book.chapters?.length || 1) - 1;
    const stat = counts();
    const panel = $('#lqc5-panel');
    $('h2', panel).textContent = last ? 'Книга прочитана' : 'Глава прочитана';
    $('.lqc5-sub', panel).textContent = `${chapter?.title || `Глава ${chapterIndex + 1}`} · ${chapterIndex + 1}/${book.chapters?.length || 1}`;
    $('.lqc5-stats', panel).innerHTML = `<div class="lqc5-stat"><b>${state.rows.length}</b><small>уникальных слов</small></div><div class="lqc5-stat"><b>${(stat.new || 0) + (stat.looked || 0)}</b><small>новых</small></div><div class="lqc5-stat"><b>${stat.learning || 0}</b><small>изучаю</small></div>`;
    const current = Number(book.comprehension?.[chapter?.id] || 0);
    $$('.lqc5-rating-grid button', panel).forEach(button => button.classList.toggle('on', Number(button.dataset.lqc5Rating) === current));
    $('[data-lqc5-action="continue"]', panel).textContent = last ? 'Вернуться в библиотеку' : 'Следующая глава →';
    $('.lqc5-vocab', panel)?.classList.remove('open');
    panel.classList.add('open'); $('#lqc5-back')?.classList.add('open');
  }

  function closePanel() {
    $('#lqc5-panel')?.classList.remove('open');
    $('#lqc5-back')?.classList.remove('open');
  }

  function setRating(score) {
    const mod = state.api, book = mod?.readerCurrentBook?.();
    const chapter = book?.chapters?.[book.currentChapter || 0];
    if (!book || !chapter) return;
    book.comprehension ||= {};
    book.comprehension[chapter.id] = score;
    book.updatedAt = new Date().toISOString();
    mod.saveReaderBooks?.();
    $$('.lqc5-rating-grid button').forEach(button => button.classList.toggle('on', Number(button.dataset.lqc5Rating) === score));
  }

  function filteredRows() {
    return state.rows.filter(item => state.filter === 'all' || item.status === state.filter);
  }

  function renderWords() {
    $$('.lqc5-tab').forEach(button => button.classList.toggle('on', button.dataset.lqc5Filter === state.filter));
    const list = $('.lqc5-list');
    if (!list) return;
    const rows = filteredRows();
    if (!rows.length) { list.innerHTML = '<div class="lqc5-empty">По этому фильтру слов нет.</div>'; return; }
    list.innerHTML = rows.map(item => `<div class="lqc5-row" data-lqc5-word="${escapeHtml(item.word)}"><div><div class="lqc5-word">${escapeHtml(item.surface || item.word)}</div><div class="lqc5-meta">встреч: ${item.frequency} · первый абзац ${(item.occurrences[0]?.paragraphIndex || 0) + 1}</div></div><span class="lqc5-state ${item.status}">${statusLabel(item.status)}</span></div>`).join('');
  }

  async function markNewKnown() {
    const mod = await api(), book = mod?.readerCurrentBook?.();
    if (!mod || !book) return;
    const targets = state.rows.filter(item => item.status === 'new' || item.status === 'looked');
    if (!targets.length) { window.showToast?.('В этой главе нет новых слов'); return; }
    if (typeof confirm === 'function' && !confirm(`Отметить известными ${targets.length} новых слов этой главы?`)) return;
    const lang = mod.readerBookLang?.(book) || globalThis.AN2_LANG || 'en';
    for (const item of targets) {
      const wordState = mod.readerGetWordState?.(item.word, lang);
      if (!wordState) continue;
      wordState.known = true;
      wordState.saved = false;
      wordState.status = 'known';
      wordState.autoKnown = false;
      wordState.updatedAt = new Date().toISOString();
      item.wordState = wordState;
      item.status = 'known';
    }
    mod.saveReaderWordState?.();
    mod.readerRefreshParagraphWordClasses?.();
    window.showToast?.(`✓ Известными отмечено: ${targets.length}`);
    const stat = counts();
    $('.lqc5-stats').innerHTML = `<div class="lqc5-stat"><b>${state.rows.length}</b><small>уникальных слов</small></div><div class="lqc5-stat"><b>${(stat.new || 0) + (stat.looked || 0)}</b><small>новых</small></div><div class="lqc5-stat"><b>${stat.learning || 0}</b><small>изучаю</small></div>`;
    renderWords();
  }

  async function openWordContext(word) {
    const mod = await api(), book = mod?.readerCurrentBook?.();
    const item = state.rows.find(row => row.word === word);
    const occurrence = item?.occurrences?.[0];
    if (!mod || !book || !occurrence) return;
    book.currentParagraph = occurrence.paragraphIndex;
    book.updatedAt = new Date().toISOString();
    mod.saveReaderBooks?.();
    closePanel();
    mod.renderReaderChapter?.();
    await wait(70);
    mod.readerOpenWordPanel?.(occurrence.surface || word, occurrence.paragraphIndex);
  }

  async function continueReading() {
    const mod = await api(), book = mod?.readerCurrentBook?.();
    if (!mod || !book) return;
    const last = Number(book.currentChapter || 0) >= (book.chapters?.length || 1) - 1;
    closePanel();
    if (last) mod.readerBackToLibrary?.();
    else mod.readerNextChapter?.();
  }

  function interceptClick(event) {
    if (!event.target.closest('[data-lqv2="next"]') || !shouldComplete()) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    openPanel();
  }

  function interceptKey(event) {
    if (event.key !== 'ArrowRight' || event.target?.matches?.('input,textarea,select') || !shouldComplete()) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    openPanel();
  }

  async function boot() {
    injectStyles();
    ensurePanel();
    await api();
    window.addEventListener('click', interceptClick, true);
    window.addEventListener('keydown', interceptKey, true);
    console.info(`[lingq completion] v${VERSION} loaded`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

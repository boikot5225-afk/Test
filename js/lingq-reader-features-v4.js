/* LingQ reading features for Reader AI v0.4.
 * Loaded after lingq-reader-shell-v2.js. Replaces the temporary paragraph-only
 * sentence mode and global viewed-word list with real sentence navigation and
 * vocabulary scoped to the open book.
 */
(() => {
  'use strict';

  const VERSION = '0.4.0';
  const MODE_KEY = 'reader_ai_lingq_sentence_mode_v1';
  const HELP_KEY = 'reader_ai_lingq_sentence_help_v1';
  const MAX_HELP = 300;
  const MAX_ROWS = 700;

  const state = {
    api: null,
    apiPromise: null,
    timer: 0,
    interval: 0,
    memory: new Map(),
    sentence: { key: '', items: [], index: 0, pending: null, positions: new Map() },
    vocabulary: { bookId: '', items: [], filter: 'all', sort: 'order', query: '' },
  };

  const $ = (selector, root = document) => root?.querySelector?.(selector) || null;
  const $$ = (selector, root = document) => [...(root?.querySelectorAll?.(selector) || [])];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function storageGet(key) {
    try {
      const value = localStorage.getItem(key);
      if (value != null) state.memory.set(key, value);
      return value ?? state.memory.get(key) ?? null;
    } catch { return state.memory.get(key) ?? null; }
  }
  function storageSet(key, value) {
    const text = String(value);
    state.memory.set(key, text);
    try { localStorage.setItem(key, text); } catch {}
  }
  function sentenceMode() { return storageGet(MODE_KEY) === '1'; }
  function setModeStored(value) { storageSet(MODE_KEY, value ? '1' : '0'); }

  function scheduleSync(delay = 20) {
    clearTimeout(state.timer);
    state.timer = setTimeout(sync, delay);
  }

  async function api() {
    if (state.api) return state.api;
    if (window.__lqReaderApiOverride) return (state.api = window.__lqReaderApiOverride);
    if (!state.apiPromise) {
      state.apiPromise = import('./reader-app.js?v=77.32')
        .then(module => (state.api = module))
        .catch(error => { console.warn('[lingq features] Reader API unavailable:', error); return null; });
    }
    return state.apiPromise;
  }

  function invoke(name, ...args) {
    const fn = window[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); }
    catch (error) {
      console.error(`[lingq features] ${name}`, error);
      window.showToast?.(`⚠️ ${error?.message || error}`);
      return undefined;
    }
  }

  function view() { return $('#reader-reading-view'); }
  function isOpen() {
    const node = view();
    return !!node && node.style.display !== 'none' && getComputedStyle(node).display !== 'none';
  }

  function injectStyles() {
    if ($('#lingq-features-v4-style')) return;
    const style = document.createElement('style');
    style.id = 'lingq-features-v4-style';
    style.textContent = `
      #reader-reading-view.lqv2-sentence #reader-chapter-text>.reader-paragraph,
      #reader-reading-view.lqv2-sentence #reader-chapter-text>.reader-paragraph.lqv2-current,
      #reader-reading-view.lqv2-sentence #reader-chapter-text>.rd-page>.reader-paragraph,
      #reader-reading-view.lqv2-sentence #reader-chapter-text>.rd-page>.reader-paragraph.lqv2-current{display:none!important}
      .lqf4-sentence-stage{display:none;min-height:calc(100dvh - 224px);padding:16px 9px 26px}
      #reader-reading-view.lqv2-sentence .lqf4-sentence-stage{display:block!important}
      #reader-reading-view.lqv2-sentence>.rd-scroll{padding-top:14px!important}
      .lqf4-sentence-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:17px;color:var(--text-muted);font-family:'IBM Plex Sans',sans-serif;font-size:.7rem}
      .lqf4-chip{padding:5px 9px;border:1px solid var(--border);border-radius:15px;background:var(--surface)}
      .lqf4-sentence-body{font-size:1.13em;line-height:1.92;min-height:9em;padding:18px 9px 8px;overflow-wrap:anywhere}
      .lqf4-help{margin-top:18px;display:flex;flex-direction:column;gap:10px}.lqf4-card{padding:13px 14px;border:1px solid var(--border);border-radius:13px;background:var(--surface);font-family:'IBM Plex Sans',sans-serif}
      .lqf4-label{font-size:.67rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:7px}.lqf4-text{font-size:.9rem;line-height:1.58}
      .lqf4-part{padding:8px 0;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent)}.lqf4-part:last-child{border-bottom:0}.lqf4-part b{display:block;margin-bottom:2px}.lqf4-part small{display:block;color:var(--text-muted);line-height:1.45}
      .lqf4-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}.lqf4-actions button{border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);padding:8px 11px;font:inherit;font-size:.73rem;cursor:pointer}.lqf4-actions button.primary{background:#18a566;color:#fff;border-color:#18a566}.lqf4-loading{color:var(--text-muted);font-size:.78rem;padding:8px 2px}
      .lqf4-vocab-back{position:fixed;inset:0;z-index:820;background:rgba(0,0,0,.58);display:none}.lqf4-vocab-back.open{display:block}
      .lqf4-vocab{position:fixed;inset:0;z-index:821;display:none;flex-direction:column;background:var(--bg);color:var(--text)}.lqf4-vocab.open{display:flex}
      .lqf4-vocab-top{flex:none;padding:max(10px,env(safe-area-inset-top)) 12px 10px;display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:8px;align-items:center;border-bottom:1px solid var(--border);background:var(--surface)}
      .lqf4-vocab-title{min-width:0}.lqf4-vocab-title b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lqf4-vocab-title small{display:block;margin-top:2px;color:var(--text-muted);font-size:.67rem}
      .lqf4-vocab-tools{flex:none;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface)}.lqf4-vocab-search{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:11px;background:var(--bg);color:var(--text);font:inherit;outline:none}
      .lqf4-filters{display:flex;gap:6px;overflow:auto;padding-top:8px;scrollbar-width:none}.lqf4-filter{flex:none;border:1px solid var(--border);border-radius:16px;background:transparent;color:var(--text-muted);padding:6px 10px;font:inherit;font-size:.69rem;cursor:pointer}.lqf4-filter.on{background:rgba(24,165,102,.14);border-color:#18a566;color:#18a566}
      .lqf4-vocab-list{flex:1;min-height:0;overflow:auto;padding:9px 10px calc(18px + env(safe-area-inset-bottom))}.lqf4-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 9px;border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);cursor:pointer}.lqf4-row:active{background:var(--surface)}
      .lqf4-word{font-family:'Lora','Noto Serif SC',serif;font-size:1.04rem;overflow-wrap:anywhere}.lqf4-meta{margin-top:3px;color:var(--text-muted);font-family:'IBM Plex Sans',sans-serif;font-size:.67rem}.lqf4-right{display:flex;align-items:center;gap:7px}
      .lqf4-state{padding:5px 8px;border-radius:12px;font-size:.65rem;white-space:nowrap;background:rgba(36,139,210,.19)}.lqf4-state.learning{background:rgba(229,188,55,.24)}.lqf4-state.known{background:rgba(24,165,102,.14)}.lqf4-state.problem{background:rgba(205,65,65,.14)}
      .lqf4-state-btn{width:32px;height:32px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--text);cursor:pointer}.lqf4-empty{padding:38px 15px;text-align:center;color:var(--text-muted);font-size:.8rem}
      @media(min-width:860px){.lqf4-vocab{left:auto;width:min(620px,100vw);box-shadow:-18px 0 60px rgba(0,0,0,.35)}}
    `;
    document.head.appendChild(style);
  }

  function currentParagraph() {
    const rows = $$('#reader-chapter-text>.reader-paragraph, #reader-chapter-text>.rd-page>.reader-paragraph');
    const active = rows.find(row => row.classList.contains('active')) || rows[0] || null;
    const position = Math.max(0, rows.indexOf(active));
    const raw = Number(active?.dataset?.p);
    return { rows, active, position, index: Number.isFinite(raw) ? raw : position };
  }

  function hash(value) {
    let h = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function locale() {
    const mod = state.api;
    const book = mod?.readerCurrentBook?.();
    const code = String(mod?.readerBookLang?.(book) || globalThis.AN2_LANG || 'en').toLowerCase();
    if (code.startsWith('zh')) return 'zh-CN';
    if (code.startsWith('ja')) return 'ja-JP';
    if (code.startsWith('fr')) return 'fr-FR';
    if (code.startsWith('es')) return 'es-ES';
    return 'en-US';
  }

  function bookPositionKey() {
    const mod = state.api;
    const book = mod?.readerCurrentBook?.();
    if (book) return `${book.id || 'book'}:${book.currentChapter || 0}:${book.currentParagraph || 0}`;
    return `${clean($('#reader-book-title')?.textContent)}:${clean($('#reader-chapter-title')?.textContent)}:${currentParagraph().index}`;
  }

  function ranges(text) {
    const raw = String(text || '');
    const out = [];
    try {
      if (typeof Intl?.Segmenter === 'function') {
        for (const part of new Intl.Segmenter(locale(), { granularity: 'sentence' }).segment(raw)) {
          let start = part.index, end = part.index + part.segment.length;
          while (start < end && /\s/.test(raw[start])) start += 1;
          while (end > start && /\s/.test(raw[end - 1])) end -= 1;
          if (end > start) out.push({ start, end, text: raw.slice(start, end) });
        }
      }
    } catch {}
    if (out.length) return out;
    const re = /[^.!?。！？…]+(?:[.!?。！？…]+["'»”’\)\]]*)?|[^.!?。！？…]+$/gu;
    let match;
    while ((match = re.exec(raw))) {
      let start = match.index, end = match.index + match[0].length;
      while (start < end && /\s/.test(raw[start])) start += 1;
      while (end > start && /\s/.test(raw[end - 1])) end -= 1;
      if (end > start) out.push({ start, end, text: raw.slice(start, end) });
      if (!match[0]) re.lastIndex += 1;
    }
    return out.length ? out : [{ start: 0, end: raw.length, text: raw.trim() }];
  }

  function domPoint(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0, node, last = null;
    while ((node = walker.nextNode())) {
      last = node;
      const length = node.nodeValue?.length || 0;
      if (offset <= total + length) return { node, offset: Math.max(0, offset - total) };
      total += length;
    }
    return last ? { node: last, offset: last.nodeValue?.length || 0 } : { node: root, offset: 0 };
  }

  function rangeHtml(root, start, end) {
    try {
      const a = domPoint(root, start), b = domPoint(root, end), range = document.createRange();
      range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
      const wrap = document.createElement('div'); wrap.appendChild(range.cloneContents());
      return wrap.innerHTML;
    } catch { return escapeHtml(String(root.textContent || '').slice(start, end)); }
  }

  function sentenceItems(paragraph) {
    const root = $('.reader-paragraph-text', paragraph) || paragraph;
    const text = String(root?.textContent || '');
    return ranges(text).map((item, index) => ({ ...item, index, html: rangeHtml(root, item.start, item.end) }));
  }

  function ensureStage() {
    const root = $('#reader-chapter-text');
    if (!root) return null;
    let stage = $('.lqf4-sentence-stage', root);
    if (stage) return stage;
    stage = document.createElement('section');
    stage.className = 'lqf4-sentence-stage';
    stage.innerHTML = `<div class="lqf4-sentence-meta"><span class="lqf4-chip">Предложение <b data-lqf4-count>1/1</b></span><span data-lqf4-paragraph>абзац 1</span></div><div class="lqf4-sentence-body"></div><div class="lqf4-help"></div><div class="lqf4-actions"><button data-lqf4-action="translate">🌐 Перевести</button><button data-lqf4-action="analyze">🧩 Разобрать</button><button class="primary" data-lqf4-action="listen">▶ Слушать</button></div>`;
    stage.addEventListener('click', event => {
      const word = event.target.closest('.reader-word');
      if (word) {
        event.preventDefault(); event.stopPropagation();
        const token = word.dataset.word || clean(word.textContent);
        state.api?.readerOpenWordPanel?.(token, currentParagraph().index) || invoke('readerOpenWordPanel', token, currentParagraph().index);
        return;
      }
      const action = event.target.closest('[data-lqf4-action]')?.dataset.lqf4Action;
      if (action === 'translate') translateSentence();
      if (action === 'analyze') analyzeSentence();
      if (action === 'listen') listenSentence();
    });
    root.prepend(stage);
    return stage;
  }

  function helpLoad() {
    try { return JSON.parse(storageGet(HELP_KEY) || '{}') || {}; } catch { return {}; }
  }
  function helpSave(data) {
    const rows = Object.entries(data).sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0));
    storageSet(HELP_KEY, JSON.stringify(Object.fromEntries(rows.slice(0, MAX_HELP))));
  }
  function currentSentence() { return state.sentence.items[state.sentence.index] || null; }
  function helpKey(item = currentSentence()) { return item ? `${bookPositionKey()}:${state.sentence.index}:${hash(item.text)}` : ''; }

  function resultText(value, seen = new Set()) {
    if (value == null) return '';
    if (typeof value === 'string') return clean(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(item => resultText(item, seen)).filter(Boolean).join('\n');
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const key of ['ru', 'translation', 'translatedText', 'translated_text', 'text', 'result', 'output', 'content', 'message', 'data']) {
      const text = resultText(value[key], seen); if (text) return text;
    }
    return '';
  }

  function analysisHtml(data) {
    const payload = data?.data || data || {};
    const parts = Array.isArray(payload.parts) ? payload.parts : Array.isArray(payload.chunks) ? payload.chunks : [];
    const whys = Array.isArray(payload.whys) ? payload.whys : [];
    const summary = clean(payload.summary || payload.explanation || '');
    if (!parts.length && !whys.length && !summary) {
      const text = resultText(payload);
      return text ? `<div class="lqf4-card"><div class="lqf4-label">Разбор</div><div class="lqf4-text">${escapeHtml(text)}</div></div>` : '';
    }
    return `<div class="lqf4-card"><div class="lqf4-label">Разбор</div>${parts.map(part => {
      const source = clean(part.fr || part.en || part.zh || part.ja || part.es || part.text || '');
      const note = clean([part.what || part.role || part.grammar || part.pinyin || '', part.why || part.ru || ''].filter(Boolean).join(' · '));
      return `<div class="lqf4-part"><b>${escapeHtml(source)}</b><small>${escapeHtml(note)}</small></div>`;
    }).join('')}${whys.map(row => `<div class="lqf4-part"><b>${escapeHtml(row.q || '')}</b><small>${escapeHtml(row.a || '')}</small></div>`).join('')}${summary ? `<div class="lqf4-part"><b>Суть</b><small>${escapeHtml(summary)}</small></div>` : ''}</div>`;
  }

  function renderStage() {
    if (!sentenceMode()) return;
    const stage = ensureStage(), item = currentSentence();
    if (!stage || !item) return;
    const paragraph = currentParagraph();
    $('[data-lqf4-count]', stage).textContent = `${state.sentence.index + 1}/${state.sentence.items.length}`;
    $('[data-lqf4-paragraph]', stage).textContent = `абзац ${paragraph.position + 1}/${Math.max(1, paragraph.rows.length)}`;
    const body = $('.lqf4-sentence-body', stage), key = helpKey(item);
    if (body.dataset.key !== key) { body.dataset.key = key; body.innerHTML = item.html || escapeHtml(item.text); }
    const cached = helpLoad()[key] || {}, help = $('.lqf4-help', stage);
    help.innerHTML = `${cached.translation ? `<div class="lqf4-card"><div class="lqf4-label">Перевод</div><div class="lqf4-text">${escapeHtml(cached.translation)}</div></div>` : ''}${cached.analysis ? analysisHtml(cached.analysis) : ''}`;
  }

  function refreshSentence(force = false) {
    if (!sentenceMode()) return;
    const paragraph = currentParagraph();
    if (!paragraph.active) return;
    const text = String($('.reader-paragraph-text', paragraph.active)?.textContent || paragraph.active.textContent || '');
    const key = `${bookPositionKey()}:${hash(text)}`;
    if (force || state.sentence.key !== key) {
      if (state.sentence.key) state.sentence.positions.set(state.sentence.key, state.sentence.index);
      state.sentence.key = key;
      state.sentence.items = sentenceItems(paragraph.active);
      const remembered = state.sentence.positions.get(key);
      state.sentence.index = state.sentence.pending === 'last'
        ? Math.max(0, state.sentence.items.length - 1)
        : state.sentence.pending === 'first' ? 0
          : Number.isFinite(remembered) ? Math.min(remembered, Math.max(0, state.sentence.items.length - 1)) : 0;
      state.sentence.pending = null;
    }
    state.sentence.index = Math.max(0, Math.min(state.sentence.index, Math.max(0, state.sentence.items.length - 1)));
    renderStage();
  }

  function setSentenceMode(enabled) {
    const node = view();
    if (!node) return;
    if (enabled && node.classList.contains('rd-pages-active')) invoke('readerTogglePagesMode');
    setModeStored(enabled);
    node.classList.toggle('lqv2-sentence', enabled);
    if (enabled) refreshSentence(true);
    scheduleSync();
  }

  async function navigate(delta) {
    if (!sentenceMode()) return invoke(delta > 0 ? 'readerNextParagraph' : 'readerPrevParagraph');
    refreshSentence();
    const target = state.sentence.index + delta;
    if (target >= 0 && target < state.sentence.items.length) {
      state.sentence.index = target;
      state.sentence.positions.set(state.sentence.key, target);
      renderStage(); syncHeader();
      return;
    }
    state.sentence.pending = delta > 0 ? 'first' : 'last';
    invoke(delta > 0 ? 'readerNextParagraph' : 'readerPrevParagraph');
    await wait(45);
    refreshSentence(true); scheduleSync();
  }

  async function listenSentence() {
    const item = currentSentence(), mod = await api();
    if (!item) return;
    const book = mod?.readerCurrentBook?.(), lang = mod?.readerBookLang?.(book) || globalThis.AN2_LANG || 'en';
    if (mod?.readerSpeakText) await mod.readerSpeakText(item.text, { lang }); else invoke('readerSpeakText', item.text, { lang });
  }

  async function sentenceAi(task) {
    const item = currentSentence(), mod = await api();
    if (!item || !mod?.readerAI) throw new Error('Reader AI API ещё не готов');
    const book = mod.readerCurrentBook?.(), sourceLang = mod.readerBookLang?.(book) || globalThis.AN2_LANG || 'en';
    return mod.readerAI({ task, text: item.text, sourceLang, targetLang: 'ru' });
  }

  function loading(text) { const root = $('.lqf4-help'); if (root) root.innerHTML = `<div class="lqf4-loading">${escapeHtml(text)}</div>`; }
  async function translateSentence() {
    const item = currentSentence(); if (!item) return;
    const key = helpKey(item), cache = helpLoad();
    if (cache[key]?.translation) return renderStage();
    loading('⏳ Перевожу предложение…');
    try {
      const translation = resultText(await sentenceAi('translate_paragraph'));
      if (!translation) throw new Error('Пустой перевод');
      cache[key] = { ...(cache[key] || {}), translation, updatedAt: Date.now() }; helpSave(cache); renderStage();
    } catch (error) { loading(`⚠️ ${error?.message || error}`); }
  }
  async function analyzeSentence() {
    const item = currentSentence(); if (!item) return;
    const key = helpKey(item), cache = helpLoad();
    if (cache[key]?.analysis) return renderStage();
    loading('⏳ Разбираю грамматику…');
    try {
      const analysis = await sentenceAi('analyze_sentence');
      cache[key] = { ...(cache[key] || {}), analysis: analysis?.data || analysis, updatedAt: Date.now() }; helpSave(cache); renderStage();
    } catch (error) { loading(`⚠️ ${error?.message || error}`); }
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
  const statusLabel = status => ({ new: 'новое', looked: 'просмотрено', learning: 'изучаю', known: 'знаю', problem: 'трудное' }[status] || status);

  async function buildVocabulary(force = false) {
    const mod = await api(), book = mod?.readerCurrentBook?.();
    if (!mod || !book) return [];
    if (!force && state.vocabulary.bookId === book.id && state.vocabulary.items.length) return state.vocabulary.items;
    const lang = mod.readerBookLang?.(book) || globalThis.AN2_LANG || 'en';
    const store = mod.loadReaderWordState?.() || {}, map = new Map();
    let order = 0;
    (book.chapters || []).forEach((chapter, chapterIndex) => {
      (chapter.paragraphs || []).forEach((paragraph, paragraphIndex) => {
        const text = contentText(paragraph); if (!text) return;
        for (const surface of mod.readerTokenizeParagraph?.(text, lang) || []) {
          const word = mod.readerNormalizeWord?.(surface, lang) || clean(surface).toLocaleLowerCase();
          if (!word || !/[\p{L}\p{N}一-鿿ぁ-ヿ]/u.test(word)) continue;
          let item = map.get(word);
          if (!item) {
            const key = mod.readerWordStateKey?.(word, lang), wordState = key ? store[key] : mod.readerGetWordState?.(word, lang);
            item = { word, surface: String(surface || word), frequency: 0, order: order++, wordState, status: statusOf(wordState), occurrences: [] };
            map.set(word, item);
          }
          item.frequency += 1;
          if (item.occurrences.length < 12) item.occurrences.push({ chapterIndex, paragraphIndex, surface: String(surface || word) });
        }
      });
    });
    state.vocabulary.bookId = book.id || bookPositionKey();
    state.vocabulary.items = [...map.values()];
    return state.vocabulary.items;
  }

  function ensureVocabulary() {
    if ($('#lqf4-vocab')) return;
    const back = document.createElement('div'); back.id = 'lqf4-vocab-back'; back.className = 'lqf4-vocab-back';
    const panel = document.createElement('section'); panel.id = 'lqf4-vocab'; panel.className = 'lqf4-vocab';
    panel.innerHTML = `<div class="lqf4-vocab-top"><button class="lqv2-btn lqv2-icon" data-lqf4-close>←</button><div class="lqf4-vocab-title"><b>Слова книги</b><small>собираю словарь…</small></div><button class="lqv2-btn lqv2-icon" data-lqf4-sort title="Сортировка">⇅</button></div><div class="lqf4-vocab-tools"><input class="lqf4-vocab-search" type="search" placeholder="Поиск по словам"><div class="lqf4-filters"><button class="lqf4-filter on" data-filter="all">Все</button><button class="lqf4-filter" data-filter="new">Новые</button><button class="lqf4-filter" data-filter="learning">Изучаю</button><button class="lqf4-filter" data-filter="known">Знаю</button><button class="lqf4-filter" data-filter="problem">Трудные</button></div></div><div class="lqf4-vocab-list"></div>`;
    document.body.append(back, panel);
    back.addEventListener('click', closeVocabulary);
    panel.addEventListener('click', async event => {
      if (event.target.closest('[data-lqf4-close]')) closeVocabulary();
      const filter = event.target.closest('[data-filter]')?.dataset.filter;
      if (filter) {
        state.vocabulary.filter = filter;
        $$('.lqf4-filter', panel).forEach(button => button.classList.toggle('on', button.dataset.filter === filter));
        renderVocabulary();
      }
      if (event.target.closest('[data-lqf4-sort]')) {
        state.vocabulary.sort = state.vocabulary.sort === 'order' ? 'frequency' : state.vocabulary.sort === 'frequency' ? 'alpha' : 'order';
        window.showToast?.(`Сортировка: ${{ order: 'по тексту', frequency: 'по частоте', alpha: 'по алфавиту' }[state.vocabulary.sort]}`);
        renderVocabulary();
      }
      const statusButton = event.target.closest('[data-lqf4-state]');
      if (statusButton) { event.stopPropagation(); await setWordStatus(statusButton.dataset.word, statusButton.dataset.lqf4State); return; }
      const row = event.target.closest('[data-lqf4-word]');
      if (row) await openOccurrence(row.dataset.lqf4Word);
    });
    $('.lqf4-vocab-search', panel)?.addEventListener('input', event => { state.vocabulary.query = event.target.value || ''; renderVocabulary(); });
  }

  async function openVocabulary() {
    ensureVocabulary();
    $('#lqf4-vocab')?.classList.add('open'); $('#lqf4-vocab-back')?.classList.add('open');
    $('.lqf4-vocab-title small').textContent = 'собираю слова всей книги…';
    await buildVocabulary(true); renderVocabulary();
  }
  function closeVocabulary() { $('#lqf4-vocab')?.classList.remove('open'); $('#lqf4-vocab-back')?.classList.remove('open'); }

  function visibleVocabulary() {
    const query = clean(state.vocabulary.query).toLocaleLowerCase();
    let rows = state.vocabulary.items.filter(item => (state.vocabulary.filter === 'all' || item.status === state.vocabulary.filter) && (!query || `${item.word} ${item.surface}`.toLocaleLowerCase().includes(query)));
    if (state.vocabulary.sort === 'frequency') rows = [...rows].sort((a, b) => b.frequency - a.frequency || a.order - b.order);
    else if (state.vocabulary.sort === 'alpha') rows = [...rows].sort((a, b) => a.word.localeCompare(b.word));
    else rows = [...rows].sort((a, b) => a.order - b.order);
    return rows.slice(0, MAX_ROWS);
  }

  function renderVocabulary() {
    const panel = $('#lqf4-vocab'); if (!panel?.classList.contains('open')) return;
    const rows = visibleVocabulary(), counts = state.vocabulary.items.reduce((out, item) => ((out[item.status] = (out[item.status] || 0) + 1), out), {});
    $('.lqf4-vocab-title small', panel).textContent = `${state.vocabulary.items.length} уникальных · новых ${counts.new || 0} · изучаю ${counts.learning || 0}`;
    const list = $('.lqf4-vocab-list', panel);
    if (!rows.length) return (list.innerHTML = '<div class="lqf4-empty">По этому фильтру слов нет.</div>');
    list.innerHTML = rows.map(item => `<div class="lqf4-row" data-lqf4-word="${escapeHtml(item.word)}"><div><div class="lqf4-word">${escapeHtml(item.surface || item.word)}</div><div class="lqf4-meta">встреч: ${item.frequency} · гл. ${(item.occurrences[0]?.chapterIndex || 0) + 1}, абз. ${(item.occurrences[0]?.paragraphIndex || 0) + 1}</div></div><div class="lqf4-right"><span class="lqf4-state ${item.status}">${statusLabel(item.status)}</span><button class="lqf4-state-btn" data-lqf4-state="${item.status === 'known' ? 'learning' : 'known'}" data-word="${escapeHtml(item.word)}" title="${item.status === 'known' ? 'Вернуть в изучение' : 'Отметить известным'}">${item.status === 'known' ? '↺' : '✓'}</button></div></div>`).join('');
  }

  async function setWordStatus(word, nextStatus) {
    const mod = await api(), book = mod?.readerCurrentBook?.(); if (!mod || !book) return;
    const lang = mod.readerBookLang?.(book) || globalThis.AN2_LANG || 'en', wordState = mod.readerGetWordState?.(word, lang); if (!wordState) return;
    wordState.updatedAt = new Date().toISOString();
    if (nextStatus === 'known') { wordState.known = true; wordState.saved = false; wordState.status = 'known'; wordState.autoKnown = false; }
    else { wordState.known = false; wordState.saved = true; wordState.status = 'learning'; }
    mod.saveReaderWordState?.(); mod.readerRefreshParagraphWordClasses?.();
    const item = state.vocabulary.items.find(row => row.word === word); if (item) { item.wordState = wordState; item.status = statusOf(wordState); }
    renderVocabulary(); scheduleSync();
  }

  async function openOccurrence(word) {
    const mod = await api(), book = mod?.readerCurrentBook?.(), item = state.vocabulary.items.find(row => row.word === word), occurrence = item?.occurrences?.[0];
    if (!mod || !book || !occurrence) return;
    book.currentChapter = occurrence.chapterIndex; book.currentParagraph = occurrence.paragraphIndex; book.updatedAt = new Date().toISOString();
    mod.saveReaderBooks?.(); closeVocabulary(); mod.renderReaderChapter?.(); await wait(80);
    if (sentenceMode()) refreshSentence(true);
    mod.readerOpenWordPanel?.(occurrence.surface || word, occurrence.paragraphIndex); scheduleSync();
  }

  function syncHeader() {
    if (!sentenceMode()) return;
    const item = currentSentence(), button = $('.lqv2-nav[data-lqv2="sentence"]'), subtitle = $('.lqv2-sub'), counter = $('.lqv2-count');
    button?.classList.add('on');
    const label = $('small', button); if (label) label.textContent = 'весь текст';
    if (counter && item) counter.textContent = `${state.sentence.index + 1}/${state.sentence.items.length}`;
    if (subtitle && item && !subtitle.textContent.startsWith('Предложение ')) subtitle.textContent = `Предложение ${state.sentence.index + 1}/${state.sentence.items.length} · ${subtitle.textContent}`;
  }

  function captureClick(event) {
    const actionNode = event.target.closest('[data-lqv2]');
    const menuNode = event.target.closest('[data-lqv2-menu]');
    const action = actionNode?.dataset.lqv2;
    const menu = menuNode?.dataset.lqv2Menu;
    const interceptAction = sentenceMode() && ['prev', 'next', 'translate', 'listen'].includes(action);
    const interceptToggle = action === 'sentence' || menu === 'sentence';
    const interceptMenu = menu === 'words' || (sentenceMode() && menu === 'analysis');
    if (!interceptAction && !interceptToggle && !interceptMenu) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
    if (interceptToggle) return setSentenceMode(!sentenceMode());
    if (action === 'prev') return navigate(-1);
    if (action === 'next') return navigate(1);
    if (action === 'translate') return translateSentence();
    if (action === 'listen') return listenSentence();
    if (menu === 'words') { $('#lqv2-backdrop')?.classList.remove('open'); $('#lqv2-sheet')?.classList.remove('open'); return openVocabulary(); }
    if (menu === 'analysis') { $('#lqv2-backdrop')?.classList.remove('open'); $('#lqv2-sheet')?.classList.remove('open'); return analyzeSentence(); }
  }

  function captureKey(event) {
    if (!isOpen() || event.target?.matches?.('input,textarea,select')) return;
    const relevant = event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === ' ' || event.key.toLowerCase() === 's';
    if (!relevant || (!sentenceMode() && event.key.toLowerCase() !== 's')) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
    if (event.key.toLowerCase() === 's') setSentenceMode(!sentenceMode());
    else if (event.key === 'ArrowLeft') navigate(-1);
    else if (event.key === 'ArrowRight') navigate(1);
    else if (event.key === ' ') listenSentence();
  }

  function sync() {
    if (!isOpen()) return;
    if (sentenceMode()) {
      view()?.classList.add('lqv2-sentence');
      refreshSentence(); syncHeader();
    }
  }

  async function boot() {
    injectStyles(); ensureVocabulary();
    document.addEventListener('click', captureClick, true);
    document.addEventListener('keydown', captureKey, true);
    await api(); sync();
    state.interval = setInterval(sync, 220);
    window.addEventListener('pagehide', () => clearInterval(state.interval), { once: true });
    console.info(`[lingq features] v${VERSION} loaded`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();

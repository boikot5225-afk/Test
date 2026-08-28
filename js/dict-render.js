// ════════════════════════════════════════════════
// dict-render.js — DICTIONARY + CHINESE DICTIONARY UI (Phase 3 extraction from app.js)
// ════════════════════════════════════════════════

import { showToast, normalizeImportKey, escapeHtml, escapeAttr } from './utils.js';
import { sb } from './supabase.js';
import { NOUNS, NOUNS_LOADED, setNounsLoaded, isGuest } from './state.js';
import { buildReaderWordSources } from './reader/word-source-filters.js?v=1';
import {
  readerAI, readerCanonicalLang, readerEnsureZhCoreJsonLoaded,
  readerEscape, readerGetCachedLexical, readerLexicalCacheKey,
  readerMarkWordSaved, readerNormalizeWord, readerPosRu,
  readerPutCachedLexical, readerScopedKey, readerSearchZhCoreJson,
  readerTouchWordState, readerWordStateKey, readerWordStatusRu,
  readerZhCoreJson, readerZhCoreJsonCount, readerZhCoreJsonPromise,
  readerZhEntryFromSources,
  hydrateReaderBooksFromIndexedDB, loadReaderBooks,
  loadReaderLexicalCache, loadReaderWordState,
  saveReaderLexicalCache, saveReaderWordState,
  renderReaderChapter, READER_BOOKS_KEY,
} from './reader-app.js?v=77.32';

// ════════════════════════════════════════════════
// DICTIONARY — Существительные и Предлоги
// ════════════════════════════════════════════════

let dictType = 'verbs'; // 'verbs' | 'nouns' | 'preps' | 'zh'
let dictNounsCache = [];
let dictPrepsCache = [];

window.setDictType = function(type) {
  dictType = type;

  // Show/hide FR vs ZH tab bars
  const tabsFr = document.getElementById('dict-tabs-fr');
  const tabsZh = document.getElementById('dict-tabs-zh');
  const curLangForDict = globalThis.AN2_LANG || 'fr';
  if (tabsFr) tabsFr.style.display = 'none';
  if (tabsZh) tabsZh.style.display = type === 'zh' ? 'block' : 'none';

  // Update tabs — только видимые кнопки
  ['verbs','reader','nouns','preps','zh'].forEach(t => {
    const btn = document.getElementById(`dict-type-${t}`);
    if (!btn) return;
    btn.style.background = t === type ? 'var(--accent)' : 'none';
    btn.style.color = t === type ? '#f5ecd8' : 'var(--text-muted)';
    btn.style.fontWeight = t === type ? '600' : '400';
  });

  // Show/hide verb filters
  const vf = document.getElementById('dict-verb-filters');
  const listWrap = document.getElementById('dict-list-wrap');
  const detailWrap = document.getElementById('dict-detail-wrap');
  const wordWrap = document.getElementById('dict-word-wrap');
  const readerWrap = document.getElementById('dict-reader-wrap');
  const genBtn = document.getElementById('dict-gen-btn');
  const manualBtn = document.getElementById('dict-manual-btn');
  const xlsxBtn = document.getElementById('dict-xlsx-btn');
  const clearWordsBtn = document.getElementById('dict-clear-words-btn');

  if (type === 'verbs') {
    if (vf) vf.style.display = 'flex';
    if (listWrap) listWrap.style.display = 'block';
    if (wordWrap) wordWrap.style.display = 'none';
    if (readerWrap) readerWrap.style.display = 'none';
    if (genBtn) genBtn.style.display = 'none';
    if (detailWrap) detailWrap.style.display = 'none';
    window.renderDict();
  } else if (type === 'reader') {
    if (vf) vf.style.display = 'none';
    if (listWrap) listWrap.style.display = 'none';
    if (detailWrap) detailWrap.style.display = 'none';
    if (wordWrap) wordWrap.style.display = 'none';
    if (readerWrap) readerWrap.style.display = 'block';
    if (genBtn) genBtn.style.display = 'none';
    if (manualBtn) manualBtn.style.display = 'none';
    if (xlsxBtn) xlsxBtn.style.display = 'none';
    renderReaderWords();
  } else {
    if (vf) vf.style.display = 'none';
    if (listWrap) listWrap.style.display = 'none';
    if (detailWrap) detailWrap.style.display = 'none';
    if (wordWrap) wordWrap.style.display = 'block';
    if (readerWrap) readerWrap.style.display = 'none';
    if (genBtn) {
      genBtn.style.display = 'none';
      genBtn.disabled = false;
      genBtn.textContent = '✨ Создать';
    }
    renderDictWords(type);
  }

  if (manualBtn) {
    manualBtn.style.display = ['nouns', 'preps', 'zh'].includes(type) ? 'inline-block' : 'none';
    manualBtn.textContent = type === 'zh' ? '+ Китайское' : '+ Вручную';
    manualBtn.setAttribute('onclick', type === 'zh' ? 'showManualChineseWordModal()' : 'showManualWordModal()');
  }
  if (xlsxBtn) xlsxBtn.style.display = ['nouns', 'preps'].includes(type) ? 'inline-block' : 'none';
  if (clearWordsBtn) clearWordsBtn.style.display = (type === 'nouns' && window.isAdmin && window.isAdmin()) ? 'inline-block' : 'none';

  // Clear search and reset gen button
  const inp = document.getElementById('dict-search');
  if (inp) {
    inp.value = '';
    if (type === 'nouns') inp.placeholder = 'Поиск: chien, beau, rapidement...';
    else if (type === 'preps') inp.placeholder = 'Поиск конструкции: penser à, parler de...';
    else if (type === 'zh') inp.placeholder = 'Поиск: 塑料布, pinyin, перевод...';
    else if (type === 'reader') inp.placeholder = 'Поиск слова или перевода...';
    else inp.placeholder = 'Поиск глагола...';
    inp.focus();
  }
  const clear = document.getElementById('dict-clear');
  if (clear) clear.style.display = 'none';
  const count = document.getElementById('dict-count');
  if (count && type === 'verbs') count.textContent = '';
};

window.onDictSearch = function() {
  const inp = document.getElementById('dict-search');
  const val = inp?.value || '';
  const clear = document.getElementById('dict-clear');
  if (clear) clear.style.display = val ? 'block' : 'none';

  // Update placeholder based on type
  if (inp) {
    if (dictType === 'nouns') inp.placeholder = 'Поиск: chien, beau, rapidement...';
    else if (dictType === 'preps') inp.placeholder = 'Поиск глагола: penser, parler, aller...';
    else if (dictType === 'zh') inp.placeholder = 'Поиск: 塑料布, pinyin, перевод...';
    else if (dictType === 'reader') inp.placeholder = 'Поиск слова или опиши мысль по-русски...';
    else inp.placeholder = 'Поиск глагола...';
  }

  if (dictType === 'verbs') {
    window.renderDict();
    return;
  }

  if (dictType === 'reader') {
    renderReaderWords(undefined, val);
    return;
  }

  const genBtn = document.getElementById('dict-gen-btn');
  const manualBtn = document.getElementById('dict-manual-btn');
  const xlsxBtn = document.getElementById('dict-xlsx-btn');
  if (genBtn) genBtn.style.display = 'none'; // DeepSeek-создание скрыто после переезда на Firebase
  if (manualBtn) {
    manualBtn.style.display = 'inline-block';
    manualBtn.textContent = dictType === 'zh' ? '+ Китайское' : '+ Вручную';
    manualBtn.setAttribute('onclick', dictType === 'zh' ? 'showManualChineseWordModal()' : 'showManualWordModal()');
  }
  if (xlsxBtn) xlsxBtn.style.display = dictType === 'zh' ? 'none' : 'inline-block';

  renderDictWords(dictType, val);
};

let readerWordsRenderSequence = 0;
let readerBooksHydrationKey = '';
let readerBooksHydrationPromise = null;

async function loadReaderWordBooks() {
  const key = readerScopedKey(READER_BOOKS_KEY);
  if (key !== readerBooksHydrationKey || !readerBooksHydrationPromise) {
    readerBooksHydrationKey = key;
    readerBooksHydrationPromise = Promise.resolve(hydrateReaderBooksFromIndexedDB()).catch(() => false);
  }
  await readerBooksHydrationPromise;
  return loadReaderBooks();
}

async function renderReaderWords(activeBookFilter, search = '') {
  const card = document.getElementById('dict-reader-card');
  if (!card) return;
  const sequence = ++readerWordsRenderSequence;
  const q = String(search || '').trim().toLowerCase();

  const escape = readerEscape;
  const wordState = loadReaderWordState();
  const books = await loadReaderWordBooks();
  if (sequence !== readerWordsRenderSequence) return;
  const { words, byBook, sources } = buildReaderWordSources(wordState, books, globalThis.AN2_LANG || 'fr');

  const requestedFilter = activeBookFilter || card.dataset.filter || 'all';
  const currentFilter = requestedFilter === 'all' || sources.some(source => source.id === requestedFilter)
    ? requestedFilter
    : 'all';
  card.dataset.filter = currentFilter;

  const filterHTML = `
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:14px">
      <label for="dict-reader-source" style="font-size:.76rem;color:var(--text-muted);white-space:nowrap">Текст:</label>
      <select id="dict-reader-source" class="select-control" style="min-width:0;max-width:100%;flex:1"
        onchange="renderReaderWords(this.value, document.getElementById('dict-search')?.value || '')">
        <option value="all" ${currentFilter === 'all' ? 'selected' : ''}>Все тексты · ${words.filter(word => word.saved).length} сохранено</option>
        ${sources.map(source => `<option value="${escapeAttr(source.id)}" ${currentFilter === source.id ? 'selected' : ''}>${escape(source.title)} · ${source.count}</option>`).join('')}
      </select>
    </div>`;

  // Слова для показа
  let shown = [];
  if (currentFilter === 'all') {
    shown = [...words].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  } else {
    shown = [...(byBook.get(currentFilter) || [])].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }

  if (q) {
    shown = shown.filter(w => {
      const ruFromCache = (() => { try { return readerGetCachedLexical(w.word, w.lang || 'en')?.ru || ''; } catch { return ''; } })();
      return String(w.word || '').toLowerCase().includes(q) || String(w.ru || ruFromCache || '').toLowerCase().includes(q);
    });
  }

  const savedWords   = shown.filter(w => w.saved);
  const openedWords  = shown.filter(w => !w.saved && (w.clicked || 0) > 0);
  // Frequency tracker: words actually clicked/looked up, ranked by how often —
  // a direct signal of what genuinely trips you up, as opposed to just words
  // that happen to appear a lot in the text (which you may already know).
  // Already-saved/known words are excluded — clicked is a lifetime counter
  // with no decay, so a word you clicked a lot before learning it would
  // otherwise sit at the top forever even after it stopped being a problem.
  const topClicked = q ? [] : [...shown].filter(w => !w.saved && !w.known && (w.clicked || 0) > 0)
    .sort((a, b) => (b.clicked || 0) - (a.clicked || 0)).slice(0, 15);

  const wordRowHTML = (w) => {
    const statusLabel = w.saved ? 'сохранено' : w.known ? 'знаю' : `открыто ${w.clicked || 1}×`;
    const statusCls   = w.saved ? 'rw-saved' : w.known ? 'rw-known' : 'rw-opened';
    // Пробуем ru из wordState, затем из кэша лексики
    const lang = w.lang || 'fr';
    const ruFromCache = (() => {
      try { return readerGetCachedLexical(w.word, lang)?.ru || ''; } catch { return ''; }
    })();
    const ruText = w.ru || ruFromCache || '';
    return `<div class="rw-row">
      <span class="rw-word">${escape(w.word)}</span>
      <span class="rw-ru">${escape(ruText)}</span>
      <span class="rw-status ${statusCls}">${escape(statusLabel)}</span>
    </div>`;
  };

  const topClickedHTML = topClicked.length ? `
    <div class="rw-section-label">🔥 Часто открываемые</div>
    <div class="rw-list">${topClicked.map(wordRowHTML).join('')}</div>` : '';

  const savedHTML = savedWords.length ? `
    <div class="rw-section-label" style="margin-top:14px">Сохранённые (${savedWords.length})</div>
    <div class="rw-list">${savedWords.map(wordRowHTML).join('')}</div>` : '';

  const openedHTML = openedWords.length ? `
    <div class="rw-section-label" style="margin-top:14px">Просмотренные (${openedWords.length})</div>
    <div class="rw-list">${openedWords.map(wordRowHTML).join('')}</div>` : '';

  const emptyHTML = !shown.length
    ? `<div style="font-size:.82rem;color:var(--text-muted);padding:8px 0">${q ? 'Ничего не найдено среди твоих слов.' : 'Нет слов из этого текста.'}</div>` : '';

  card.innerHTML = filterHTML + topClickedHTML + savedHTML + openedHTML + emptyHTML + renderReverseLookupBlock(q);
}
window.renderReaderWords = renderReaderWords;

// "Как сказать" (RU → target word) and "Перевести" (target word → RU) —
// two directions of the same idea: search only finds words already in your
// saved vocabulary, so anything typed that isn't there yet gets a DeepSeek
// fallback either way. Shared between the reader dictionary (en/es/fr) and
// the Chinese dictionary.
function renderReverseLookupBlock(q) {
  if (!q) return '';
  return `
    <div id="dict-reverse-lookup" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary" style="flex:1;min-width:140px" onclick="onReaderForwardTranslate()">🔤 Перевести «${readerEscape(q)}»?</button>
      <button class="btn btn-secondary" style="flex:1;min-width:140px" onclick="onReaderReverseLookup()">🔍 Как сказать «${readerEscape(q)}»?</button>
    </div>
    <div id="dict-reverse-results" style="margin-top:10px"></div>`;
}

// "Перевести" — the word/phrase typed is already IN the target language;
// just translate it to Russian (as opposed to onReaderReverseLookup, which
// goes the other way: a Russian description → target-language word).
window.onReaderForwardTranslate = async function onReaderForwardTranslate() {
  const inp = document.getElementById('dict-search');
  const query = String(inp?.value || '').trim();
  if (!query) return;
  const results = document.getElementById('dict-reverse-results');
  if (!results) return;
  const lang = readerCanonicalLang(globalThis.AN2_LANG || 'en');
  results.innerHTML = `<div style="font-size:.82rem;color:var(--text-muted)">⏳ DeepSeek переводит...</div>`;
  try {
    const d = await readerAI({ task: 'translate_paragraph', text: query, sourceLang: lang });
    const ru = String(d?.ru || '').trim();
    if (!ru) {
      results.innerHTML = `<div style="font-size:.82rem;color:var(--text-muted)">Не получилось перевести.</div>`;
      return;
    }
    results.innerHTML = `
      <div class="rw-row" style="align-items:center">
        <span class="rw-word">${readerEscape(query)}</span>
        <span class="rw-ru" style="flex:1">${readerEscape(ru)}</span>
        <button class="btn btn-secondary" style="padding:6px 10px;font-size:.76rem;white-space:nowrap"
          data-word="${escapeAttr(query)}" data-ru="${escapeAttr(ru)}"
          onclick="onReaderSaveReverseSuggestion(this)">＋ Сохранить</button>
      </div>`;
  } catch (e) {
    results.innerHTML = `<div style="font-size:.82rem;color:var(--bad)">⚠️ DeepSeek не сработал: ${readerEscape(e?.message || String(e))}</div>`;
  }
};

// "Как сказать X по-английски/испански" — the reverse of the usual dict
// search (word → meaning): describe the idea in Russian, DeepSeek suggests
// the target-language word(s) with a short note on nuance/when to use each,
// and any suggestion can be saved straight into the reader dictionary.
window.onReaderReverseLookup = async function onReaderReverseLookup() {
  const inp = document.getElementById('dict-search');
  const query = String(inp?.value || '').trim();
  if (!query) return;
  const results = document.getElementById('dict-reverse-results');
  if (!results) return;
  const lang = readerCanonicalLang(globalThis.AN2_LANG || 'en');
  results.innerHTML = `<div style="font-size:.82rem;color:var(--text-muted)">⏳ DeepSeek подбирает слово...</div>`;
  try {
    const d = await readerAI({ task: 'reverse_lookup', query, sourceLang: lang });
    const suggestions = Array.isArray(d?.suggestions) ? d.suggestions.filter(s => s && s.word) : [];
    if (!suggestions.length) {
      results.innerHTML = `<div style="font-size:.82rem;color:var(--text-muted)">Не получилось подобрать вариант.</div>`;
      return;
    }
    results.innerHTML = suggestions.map(s => `
      <div class="rw-row" style="align-items:center">
        <span class="rw-word">${readerEscape(s.word)}</span>
        <span class="rw-ru" style="flex:1">${readerEscape(s.note || '')}</span>
        <button class="btn btn-secondary" style="padding:6px 10px;font-size:.76rem;white-space:nowrap"
          data-word="${escapeAttr(s.word)}" data-ru="${escapeAttr(query)}"
          onclick="onReaderSaveReverseSuggestion(this)">＋ Сохранить</button>
      </div>`).join('');
  } catch (e) {
    results.innerHTML = `<div style="font-size:.82rem;color:var(--bad)">⚠️ DeepSeek не сработал: ${readerEscape(e?.message || String(e))}</div>`;
  }
};

window.onReaderSaveReverseSuggestion = function onReaderSaveReverseSuggestion(btn) {
  const word = btn?.dataset?.word || '';
  const ru = btn?.dataset?.ru || '';
  if (!word) return;
  const lang = readerCanonicalLang(globalThis.AN2_LANG || 'en');
  readerMarkWordSaved(word, word, lang, ru);
  showToast(`＋ «${word}» добавлено в словарь`);
  btn.disabled = true;
  btn.textContent = '✓ Сохранено';
};

window.renderDictWords = renderDictWords;
async function renderDictWords(type, search = '') {
  const card = document.getElementById('dict-word-card');
  const count = document.getElementById('dict-count');
  if (!card) return;

  if (type === 'zh') {
    renderChineseDictWords(search);
    return;
  }

  const table = type === 'nouns' ? 'nouns' : 'prepositions';
  const cache = type === 'nouns' ? dictNounsCache : dictPrepsCache;

  // Load from Firebase if cache empty
  if (!cache.length) {
    card.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">⏳ Загрузка...</div>`;
    try {
      const { data } = await sb.from(table).select('*').order('fr', { ascending: true });
      if (data) {
        if (type === 'nouns') dictNounsCache = data;
        else dictPrepsCache = data;
      }
    } catch(e) {
      card.innerHTML = `<div style="color:var(--bad);padding:20px">Ошибка загрузки</div>`;
      return;
    }
  }

  const src = type === 'nouns' ? dictNounsCache : dictPrepsCache;
  const q = search.toLowerCase().trim();
  const filtered = q
    ? src.filter(w => {
        // Search across all text fields for a detailed match
        const haystacks = [
          w.fr, w.ru, w.verb, w.transcription, w.fem, w.plural, w.derived_from,
          ...(Array.isArray(w.examples) ? w.examples.flatMap(e => [e.fr, e.ru]) : []),
          ...(Array.isArray(w.synonyms) ? w.synonyms.map(s => s.fr) : []),
          ...(Array.isArray(w.collocations) ? w.collocations.map(c => c.fr) : []),
        ];
        return haystacks.some(h => h && h.toLowerCase().includes(q));
      })
    : src;

  if (count) count.textContent = `${filtered.length} ${type === 'nouns' ? 'слов' : 'конструкций'}`;

  if (!filtered.length && !q) {
    const hint = type === 'nouns'
      ? 'Например: chien, maison, voiture, chiens...'
      : 'Например: penser, parler de, avoir besoin...';
    card.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
        <div style="font-size:2.5rem;margin-bottom:12px">${type === 'nouns' ? '📦' : '🔗'}</div>
        <div style="font-size:0.95rem;font-weight:500;margin-bottom:8px;color:var(--text)">Введи слово для поиска</div>
        <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:16px">${hint}</div>
        <div style="font-size:0.8rem;padding:10px 16px;background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.2);border-radius:8px;color:var(--accent)">
          Ручная база: добавляй слова сам или импортируй XLSX
        </div>
      </div>`;
    return;
  }

  if (!filtered.length && q) {
    card.innerHTML = `
      <div style="text-align:center;padding:30px 20px;color:var(--text-muted)">
        <div style="font-size:0.9rem;margin-bottom:8px">Слово «${q}» не найдено в базе</div>
        <div style="font-size:0.8rem;color:var(--text-dim)">Нажми «+ Вручную» и добавь запись сам</div>
      </div>`;
    return;
  }

  // List of words
  card.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      ${filtered.map(w => type === 'nouns' ? renderNounListItem(w) : renderPrepListItem(w)).join('')}
    </div>`;
};


// ════════════════════════════════════════════════
// CHINESE DICTIONARY — отдельный словарь для чтения 中文
// ════════════════════════════════════════════════


function readerChineseDictionaryEntries() {
  const map = new Map();
  const add = (word, st = null) => {
    const entry = readerZhEntryFromSources(word, st);
    if (entry?.word) map.set(entry.word, { ...(map.get(entry.word) || {}), ...entry, state: entry.state || map.get(entry.word)?.state || null });
  };

  const states = loadReaderWordState();
  Object.values(states).forEach(st => {
    if (!st || readerCanonicalLang(st.lang) !== 'zh') return;
    add(st.word, st);
  });

  const cache = loadReaderLexicalCache();
  Object.entries(cache).forEach(([key, item]) => {
    if (!key.startsWith('zh:') || !item) return;
    add(item.word || item.surface || item.lemma || key.slice(3), null);
  });

  return Array.from(map.values()).sort((a,b) => {
    const ast = a.state || {}, bst = b.state || {};
    const rank = (st) => st.status === 'problem' || st.status === 'hard' ? 0 : st.status === 'learning' || st.saved ? 1 : st.status === 'familiar' ? 2 : st.status === 'looked' || (st.clicked || 0) > 0 ? 3 : 4;
    const r = rank(ast) - rank(bst);
    if (r) return r;
    return String(a.word).localeCompare(String(b.word), 'zh-Hans-CN');
  });
}

function renderChineseDictWords(search = '') {
  const card = document.getElementById('dict-word-card');
  const count = document.getElementById('dict-count');
  if (!card) return;
  const q = String(search || '').trim().toLowerCase();
  const entries = readerChineseDictionaryEntries();
  let filtered = q ? entries.filter(e => [e.word, e.lemma, e.pinyin, e.ru, e.en, e.pos, e.level, readerWordStatusRu(e.state)].some(x => String(x || '').toLowerCase().includes(q))) : entries;
  if (q && readerZhCoreJson) {
    const coreHits = readerSearchZhCoreJson(q, 80);
    const byWord = new Map(filtered.map(e => [e.word, e]));
    coreHits.forEach(e => { if (!byWord.has(e.word)) byWord.set(e.word, e); });
    filtered = Array.from(byWord.values());
  }
  const coreCount = readerZhCoreJsonCount();
  if (count) count.textContent = q
    ? `${filtered.length} найдено · CC-CEDICT ${coreCount || '…'}`
    : `${filtered.length} личных китайских слов · CC-CEDICT ${coreCount || '…'}`;

  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: false }).then(() => { try { if (dictType === 'zh') renderChineseDictWords(search); } catch {} });

  // Frequency tracker: words actually clicked/looked up, ranked by how often.
  // Already-saved/known words excluded — clicked never decays, so an
  // already-learned word clicked a lot in the past would otherwise stick at
  // the top forever.
  const topClicked = q ? [] : [...entries].filter(e => {
    const st = e.state || {};
    return !st.saved && !st.known && (st.clicked || 0) > 0;
  }).sort((a, b) => (b.state?.clicked || 0) - (a.state?.clicked || 0)).slice(0, 15);
  const topClickedHTML = topClicked.length ? `
    <div style="font-size:0.78rem;font-weight:600;color:var(--text-muted);margin-bottom:8px">🔥 Часто открываемые</div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px">
      ${topClicked.map(renderChineseDictListItem).join('')}
    </div>` : '';

  if (!filtered.length && !q) {
    card.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
        <div style="font-size:2.5rem;margin-bottom:12px">中文</div>
        <div style="font-size:0.95rem;font-weight:500;margin-bottom:8px;color:var(--text)">Личный китайский словарь пока пуст</div>
        <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:16px">Открывай слова в читалке или ищи по 中文 / pinyin / English fallback в общем CC-CEDICT.</div>
        <div style="font-size:0.8rem;padding:10px 16px;background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.2);border-radius:8px;color:var(--accent)">Общий словарь нужен для разметки и pinyin; русский смысл добирается через DeepSeek или ручные правки.</div>
      </div>`;
    return;
  }
  if (!filtered.length && q) {
    card.innerHTML = `
      <div style="text-align:center;padding:30px 20px;color:var(--text-muted)">
        <div style="font-size:0.9rem;margin-bottom:8px">«${readerEscape(search)}» не найдено в китайском словаре</div>
        <div style="font-size:0.8rem;color:var(--text-dim)">Нажми «+ Китайское» и добавь вручную.</div>
      </div>` + renderReverseLookupBlock(q);
    return;
  }

  card.innerHTML = topClickedHTML + `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      ${filtered.map(renderChineseDictListItem).join('')}
    </div>` + renderReverseLookupBlock(q);
}

function renderChineseDictListItem(e) {
  const st = e.state || {};
  const status = readerWordStatusRu(st);
  const statusColor = (st.status === 'problem' || st.status === 'hard') ? 'var(--bad)' : st.known || st.status === 'known' ? 'var(--text-muted)' : st.status === 'familiar' ? 'var(--good)' : st.saved || st.status === 'learning' ? 'var(--blue)' : 'var(--accent)';
  return `
    <div onclick="showChineseDictCard('${escapeAttr(e.word)}')"
      style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.12s"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <div style="font-family:system-ui,'Noto Sans SC','Microsoft YaHei',sans-serif;font-size:1.25rem;min-width:96px;color:var(--text)">${readerEscape(e.word)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${readerEscape(e.pinyin || '—')}</div>
        <div style="font-size:0.82rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${readerEscape(e.ru || e.en || 'перевод появится после DeepSeek/ручного добавления')}</div>
      </div>
      <div style="font-size:0.68rem;padding:2px 7px;border-radius:10px;border:1px solid ${statusColor};color:${statusColor};white-space:nowrap">${readerEscape(status)}</div>
    </div>`;
}

window.showChineseDictCard = function(word) {
  const card = document.getElementById('dict-word-card');
  if (!card) return;
  const entry = readerZhEntryFromSources(word);
  if (!entry) return;
  const st = entry.state || {};
  const status = readerWordStatusRu(st);
  const sourceLabel = entry.source === 'cc-cedict' ? 'CC-CEDICT/lang_dictionary' : entry.source === 'cc-cedict-full' ? 'CC-CEDICT full' : entry.source === 'zh_core_json' || entry.source === 'reader-core-extra' || entry.source === 'local-core' || entry.source === 'reading-core' ? 'локальный CC-core' : entry.source === 'local' ? 'локальный словарь' : entry.source === 'cache' ? 'кэш разбора' : 'статус чтения';
  card.innerHTML = `
    <button onclick="renderDictWords('zh', document.getElementById('dict-search')?.value || '')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;margin-bottom:14px;padding:0;font-family:'IBM Plex Sans',sans-serif">← Все китайские слова</button>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
      <div style="padding:18px 20px 14px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(212,175,55,0.06) 0%,transparent 60%)">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <span style="font-family:system-ui,'Noto Sans SC','Microsoft YaHei',sans-serif;font-size:2.2rem;font-weight:600">${readerEscape(entry.word)}</span>
          <button onclick="window.readerSpeakText('${escapeAttr(entry.word)}',{lang:'zh'})" title="Произнести" style="background:none;border:1px solid var(--border);border-radius:50%;width:32px;height:32px;cursor:pointer;color:var(--text-muted);font-size:0.85rem;flex-shrink:0">🔊</button>
          ${entry.pos ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--text-muted);background:var(--surface2);border-radius:6px;padding:2px 8px">${readerEscape(readerPosRu(entry.pos))}</span>` : ''}
        </div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:1rem;color:var(--accent);margin-bottom:8px">${readerEscape(entry.pinyin || 'пиньинь не задан')}</div>
        <div style="font-size:1.05rem;font-weight:500;margin-bottom:8px">${entry.ru ? readerEscape(entry.ru) : '<span style="color:var(--text-muted)">русский перевод не задан</span>'}</div>
        ${entry.en && !entry.ru ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:8px">EN fallback: ${readerEscape(entry.en)}</div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid var(--border);color:var(--text-muted)">${readerEscape(status)}</span>
          ${entry.level ? `<span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid var(--border);color:var(--text-muted)">${readerEscape(entry.level)}</span>` : ''}
          <span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid var(--border);color:var(--text-muted)">${readerEscape(sourceLabel)}</span>
        </div>
      </div>
      ${entry.note ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border);font-size:0.86rem;color:var(--text-muted);line-height:1.5">${readerEscape(entry.note)}</div>` : ''}
      <div style="padding:14px 20px;display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="zhDictSetStatus('${escapeAttr(entry.word)}','learning')" class="btn btn-secondary" style="flex:1;min-width:120px">изучаю</button>
        <button onclick="zhDictSetStatus('${escapeAttr(entry.word)}','problem')" class="btn btn-secondary" style="flex:1;min-width:120px">⚠ проблема</button>
        <button onclick="zhDictSetStatus('${escapeAttr(entry.word)}','familiar')" class="btn btn-secondary" style="flex:1;min-width:120px">закрепляю</button>
        <button onclick="zhDictSetStatus('${escapeAttr(entry.word)}','known')" class="btn btn-primary" style="flex:1;min-width:120px">✓ знаю</button>
        <button onclick="showManualChineseWordModal('${escapeAttr(entry.word)}')" class="btn btn-secondary" style="flex:1;min-width:120px">✏️ править</button>
        <button onclick="zhDictDeleteWord('${escapeAttr(entry.word)}')" class="btn btn-secondary" style="flex:1;min-width:120px;color:var(--bad);border-color:rgba(166,42,33,.35)">🗑 удалить</button>
      </div>
    </div>`;
};

window.zhDictDeleteWord = function(word) {
  const w = readerNormalizeWord(word, 'zh');
  if (!w) return;
  const state = loadReaderWordState();
  delete state[readerWordStateKey(w, 'zh')];
  saveReaderWordState();
  const cache = loadReaderLexicalCache();
  delete cache[readerLexicalCacheKey(w, 'zh')];
  saveReaderLexicalCache();
  try { renderReaderChapter(); } catch {}
  dictType = 'zh';
  renderDictWords('zh', document.getElementById('dict-search')?.value || '');
  showToast('中文 Удалено из личного китайского словаря');
};

window.zhDictSetStatus = function(word, status) {
  const w = readerNormalizeWord(word, 'zh');
  if (!w) return;
  const st = readerTouchWordState(w, 'zh');
  st.saved = status !== 'known';
  st.known = status === 'known';
  st.status = status;
  st.updatedAt = new Date().toISOString();
  saveReaderWordState();
  try { renderReaderChapter(); } catch {}
  window.showChineseDictCard(w);
};

window.showManualChineseWordModal = function(prefillWord = '') {
  const w0 = readerNormalizeWord(prefillWord || prompt('Китайское слово / выражение:', '') || '', 'zh');
  if (!w0) return;
  const old = readerZhEntryFromSources(w0) || {};
  const pinyin = prompt('Pinyin:', old.pinyin || '') || old.pinyin || '';
  const ru = prompt('Русский перевод:', old.ru || '') || old.ru || '';
  const pos = prompt('Часть речи / пометка:', old.pos || '') || old.pos || '';
  readerPutCachedLexical(w0, {
    ...(readerGetCachedLexical(w0, 'zh') || {}),
    lang: 'zh', word: w0, surface: w0, lemma: w0,
    pinyin: String(pinyin || '').trim(),
    ru: String(ru || '').trim(),
    translation: String(ru || '').trim(),
    pos: String(pos || '').trim(),
    _source: 'manual_zh',
    _note: 'ручная запись китайского словаря'
  }, 'zh');
  readerMarkWordSaved(w0, w0, 'zh');
  try { const st = loadReaderWordState()[readerWordStateKey(w0, 'zh')]; if (st) { st.manual = true; st.updatedAt = new Date().toISOString(); saveReaderWordState(); } } catch {}
  dictType = 'zh';
  renderDictWords('zh', document.getElementById('dict-search')?.value || '');
  showToast('中文 Добавлено в китайский словарь');
  try { renderReaderChapter(); } catch {}
};


function dictSimplifyWordPos(w) {
  const p = String(w?.pos || '').toLowerCase();
  if (['adj','adjective','adjectif'].includes(p)) return 'adjective';
  if (['adv','adverb','adverbe'].includes(p)) return 'adverb';
  if (['prep','preposition','préposition'].includes(p)) return 'preposition';
  if (['pronoun','pronom'].includes(p)) return 'pronoun';
  if (['other','autre'].includes(p)) return 'other';
  return 'noun';
}

function dictWordPosLabel(pos) {
  return { noun:'сущ.', adjective:'прил.', adverb:'нареч.', preposition:'предл.', pronoun:'мест.', other:'др.' }[pos] || 'др.';
}

function renderNounListItem(w) {
  const wordPos = dictSimplifyWordPos(w);
  const isAdj = wordPos === 'adjective';
  const isAdv = wordPos === 'adverb';
  const article = wordPos === 'noun' && !w.no_article ? (w.gender === 'm' ? 'le' : 'la') : '';
  const levelColor = w.level === 'A1' ? 'var(--good)' : w.level === 'A2' ? 'var(--accent)' : 'var(--blue)';
  return `
    <div onclick="showDictWordCard('noun','${w.id}')"
      style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.12s"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem;min-width:120px">
        ${article ? `<span style="color:var(--accent)">${article}</span> ` : ''}${w.fr}${wordPos !== 'noun' ? ` <span style="font-size:0.7rem;color:var(--text-dim);font-style:normal">${dictWordPosLabel(wordPos)}</span>` : ''}
      </div>
      <div style="flex:1;font-size:0.82rem;color:var(--text-muted)">${w.ru}</div>
      <div style="font-size:0.68rem;padding:2px 7px;border-radius:10px;border:1px solid ${levelColor};color:${levelColor}">${w.level||'A1'}</div>
    </div>`;
}

function renderPrepListItem(w) {
  const preps = (w.preps || []).map(p => p.prep).join(', ');
  return `
    <div onclick="showDictWordCard('prep','${w.id}')"
      style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.12s"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem;min-width:120px">${w.verb}</div>
      <div style="flex:1;font-size:0.82rem;color:var(--text-muted)">${w.ru}</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:0.75rem;color:var(--blue)">${preps}</div>
    </div>`;
}

window.showDictWordCard = async function(type, id) {
  const card = document.getElementById('dict-word-card');
  if (!card) return;

  const src = type === 'noun' ? dictNounsCache : dictPrepsCache;
  // Loose compare — id from onclick is a string, but in cache it may be a number
  const w = src.find(x => String(x.id) === String(id));
  if (!w) { alert('Слово не найдено: id=' + id); return; }

  try {
    card.innerHTML = type === 'noun' ? renderNounCard(w) : renderPrepCard(w);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    alert('Ошибка отрисовки "' + (w.fr||'?') + '": ' + e.message);
  }
};

function renderAdvCard(w) {
  const levelColor = w.level === 'A1' ? 'var(--good)' : w.level === 'A2' ? 'var(--accent)' : 'var(--blue)';

  const examples = (w.examples || []).map((e, i) => `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:0.7rem;color:var(--accent);min-width:16px;margin-top:2px">${i+1}.</div>
      <div style="flex:1">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.92rem;color:var(--text);line-height:1.4;margin-bottom:2px;flex:1">${e.fr}</div>
          <button onclick="speakText(this)" data-speak="${escapeAttr(e.fr)}" title="Произнести" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:0.85rem;flex-shrink:0;padding:0">🔊</button>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${e.ru}</div>
      </div>
    </div>`).join('');

  const synonyms = (w.synonyms || []).map(s =>
    `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font-size:0.82rem">${s.fr} <span style="color:var(--text-muted);font-size:0.75rem">${s.ru}</span></div>`
  ).join('');

  const antonyms = (w.antonyms || []).map(s =>
    `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font-size:0.82rem">${s.fr} <span style="color:var(--text-muted);font-size:0.75rem">${s.ru}</span></div>`
  ).join('');

  const derived = w.derived_from && w.derived_from !== 'null'
    ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:6px">← от <em>${w.derived_from}</em></div>`
    : '';

  return `
    <button onclick="renderDictWords('${dictType}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;margin-bottom:14px;padding:0;font-family:'IBM Plex Sans',sans-serif">← Все слова</button>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
      <div style="padding:18px 20px 14px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(212,175,55,0.06) 0%,transparent 60%)">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px">
          <span style="font-family:'Playfair Display',serif;font-size:2rem;font-weight:600">${w.fr}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:0.8rem;color:var(--text-muted);background:var(--surface2);border-radius:6px;padding:2px 8px">нареч.</span>
        </div>
        ${w.transcription ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:0.82rem;color:var(--text-dim);margin-bottom:6px">${w.transcription} · наречие</div>` : ''}
        ${derived}
        <div style="font-size:1.05rem;font-weight:500;margin-bottom:8px">${w.ru}</div>
        <span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid ${levelColor};color:${levelColor}">${w.level||'B1'}</span>
      </div>
      ${examples ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">📝 Примеры</div>${examples}</div>` : ''}
      ${synonyms ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px">≈ Синонимы</div><div style="display:flex;flex-wrap:wrap;gap:6px">${synonyms}</div></div>` : ''}
      ${antonyms ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px">↔ Антонимы</div><div style="display:flex;flex-wrap:wrap;gap:6px">${antonyms}</div></div>` : ''}
      <div style="padding:14px 20px;display:flex;gap:8px;">
        <button onclick="editDictWord('noun','${w.id}')" style="flex:1;padding:12px;background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.3);border-radius:10px;color:var(--accent);font-family:'IBM Plex Sans',sans-serif;font-size:0.88rem;cursor:pointer">
          ✏️ Редактировать
        </button>
        <button onclick="deleteDictWord('noun','${w.id}')" style="padding:12px 14px;background:rgba(255,59,48,0.06);border:1px solid rgba(255,59,48,0.25);border-radius:10px;color:var(--bad);font-family:'IBM Plex Sans',sans-serif;font-size:0.88rem;cursor:pointer">
          🗑
        </button>
      </div>
    </div>`;
}


function renderNounCard(w) {
  const wordPos = dictSimplifyWordPos(w);
  if (wordPos === 'adverb') return renderAdvCard({ ...w, pos: 'adv' });
  const isAdj = wordPos === 'adjective';
  const isOtherWord = wordPos !== 'noun' && wordPos !== 'adjective';
  const article = wordPos === 'noun' && !w.no_article ? (w.gender === 'm' ? 'le' : 'la') : '';
  const levelColor = w.level === 'A1' ? 'var(--good)' : w.level === 'A2' ? 'var(--accent)' : 'var(--blue)';
  const canEdit = window.isAdmin && window.isAdmin();
  const examples = (w.examples || []).map((e, i) => `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:0.7rem;color:var(--accent);min-width:16px;margin-top:2px">${i+1}.</div>
      <div style="flex:1">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.92rem;color:var(--text);line-height:1.4;margin-bottom:2px;flex:1">${e.fr}</div>
          <button onclick="speakText(this)" data-speak="${escapeAttr(e.fr)}" title="Произнести" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:0.85rem;flex-shrink:0;padding:0">🔊</button>
          ${canEdit ? `<button onclick="editDictExample('noun','${w.id}',${i})" title="Редактировать пример" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:.8rem;padding:0">✏️</button>` : ''}
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${e.ru || '<span style="opacity:.65">перевод не задан</span>'}</div>
      </div>
    </div>`).join('');

  const collocations = (w.collocations || []).map(c => `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.88rem">
      <span style="font-family:'Playfair Display',serif;font-style:italic;color:var(--text)">${c.fr}</span>
      <span style="font-size:0.78rem;color:var(--text-muted)">${c.ru}</span>
    </div>`).join('');

  const related = (w.related || []).map(r => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font-family:'IBM Plex Mono',monospace;font-size:0.82rem;color:var(--text)">
      ${r.fr} <span style="color:var(--text-muted);font-size:0.75rem">${r.ru}</span>
    </div>`).join('');

  return `
    <button onclick="renderDictWords('${dictType}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;margin-bottom:14px;padding:0;font-family:'IBM Plex Sans',sans-serif">← Все слова</button>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
      <!-- Header -->
      <div style="padding:18px 20px 14px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(212,175,55,0.06) 0%,transparent 60%)">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px">
          ${article ? `<span style="font-family:'Playfair Display',serif;font-size:2rem;font-style:italic;color:var(--accent)">${article}</span>` : ''}
          <span style="font-family:'Playfair Display',serif;font-size:2rem;font-weight:600">${w.fr}</span>
          <button onclick="speak('${(article ? article + ' ' : '') + (w.fr || '')}')" title="Произнести" style="background:none;border:1px solid var(--border);border-radius:50%;width:30px;height:30px;cursor:pointer;color:var(--text-muted);font-size:0.8rem;flex-shrink:0">🔊</button>
          ${isAdj
            ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:0.8rem;color:var(--text-muted);background:var(--surface2);border-radius:6px;padding:2px 8px">прил.</span>`
            : isOtherWord
              ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:0.8rem;color:var(--text-muted);background:var(--surface2);border-radius:6px;padding:2px 8px">${dictWordPosLabel(wordPos)}</span>`
              : `<span style="font-family:'IBM Plex Mono',monospace;font-size:0.8rem;color:var(--text-muted);background:var(--surface2);border-radius:6px;padding:2px 8px">${w.plural ? 'les ' + w.plural : ''}</span>`}
        </div>
        ${w.transcription ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:0.82rem;color:var(--text-dim);margin-bottom:6px">${w.transcription} · ${isAdj ? 'прилагательное' : isOtherWord ? dictWordPosLabel(wordPos) : w.gender === 'm' ? 'муж. род' : 'жен. род'}</div>` : ''}
        <div style="font-size:1.05rem;font-weight:500;margin-bottom:8px">${w.ru || '<span style="color:var(--text-muted)">перевод не задан</span>'}</div>
        ${canEdit ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button onclick="editDictWord('noun','${w.id}')" class="btn btn-secondary" style="padding:5px 9px;font-size:.72rem">✏️ запись</button><button onclick="addDictTranslation('noun','${w.id}')" class="btn btn-secondary" style="padding:5px 9px;font-size:.72rem">+ перевод</button><button onclick="editDictExample('noun','${w.id}',-1)" class="btn btn-secondary" style="padding:5px 9px;font-size:.72rem">+ пример</button></div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid ${levelColor};color:${levelColor}">${w.level||'A1'}</span>
          ${w.theme ? `<span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid var(--border);color:var(--text-muted)">${w.theme}</span>` : ''}
        </div>
      </div>
      <!-- Forms -->
      <div style="padding:14px 20px;border-bottom:1px solid var(--border)">
        <div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">📐 Формы</div>
        ${isOtherWord ? `
        <div style="font-size:0.86rem;color:var(--text-muted);line-height:1.5">Это не существительное, поэтому артикль и род не показываются. Сохраняется как обычная лексическая единица.</div>
        ` : isAdj ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
            <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:2px">муж. ед.ч.</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:0.88rem">${w.fr}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
            <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:2px">жен. ед.ч.</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:0.88rem">${w.fem || w.fr + 'e'}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
            <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:2px">муж. мн.ч.</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:0.88rem">${w.masc_pl || w.fr + 's'}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
            <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:2px">жен. мн.ч.</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:0.88rem">${w.fem_pl || (w.fem || w.fr + 'e') + 's'}</div>
          </div>
        </div>` : `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
            <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:2px">ед.ч.</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:0.88rem"><span style="color:var(--accent)">${article}</span> ${w.fr}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
            <div style="font-size:0.68rem;color:var(--text-dim);margin-bottom:2px">мн.ч.</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:0.88rem"><span style="color:var(--accent)">les</span> ${w.plural || w.fr + 's'}</div>
          </div>
        </div>`}
      </div>
      ${examples ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">📝 Примеры</div>${examples}</div>` : ''}
      ${collocations ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">🔗 Устойчивые выражения</div>${collocations}</div>` : ''}
      ${related ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">🌿 Однокоренные</div><div style="display:flex;flex-wrap:wrap;gap:6px">${related}</div></div>` : ''}
      <div style="padding:14px 20px;display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="startNounTrainFromDict('${w.id}')" style="flex:1;min-width:160px;padding:12px;background:rgba(212,175,55,0.1);border:1px solid var(--accent);border-radius:10px;color:var(--accent);font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:0.88rem;cursor:pointer">
          🎯 Тренировать
        </button>
        ${canEdit ? `<button onclick="editDictWord('noun','${w.id}')" style="padding:12px 14px;background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.3);border-radius:10px;color:var(--accent);font-family:'IBM Plex Sans',sans-serif;font-size:0.88rem;cursor:pointer" title="Редактировать слово">✏️</button>` : ''}
        <button onclick="deleteDictWord('noun','${w.id}')" style="padding:12px 14px;background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.3);border-radius:10px;color:var(--bad);font-family:'IBM Plex Sans',sans-serif;font-size:0.88rem;cursor:pointer" title="Удалить слово">
          🗑
        </button>
      </div>
    </div>`;
}

function renderPrepCard(w) {
  const prepsHtml = (w.preps || []).map(p => `
    <div style="background:rgba(10,132,255,0.08);border:1px solid rgba(10,132,255,0.25);border-radius:8px;padding:10px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-family:'IBM Plex Mono',monospace;color:var(--blue);font-size:1rem;font-weight:500">${w.verb} ${p.prep}</span>
        <span style="font-size:0.78rem;color:var(--text-muted)">— ${p.meaning}</span>
      </div>
      <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.88rem;color:var(--text);margin-bottom:2px">${p.example_fr}</div>
      <div style="font-size:0.75rem;color:var(--text-dim)">${p.example_ru}</div>
    </div>`).join('');

  const canEdit = window.isAdmin && window.isAdmin();
  const examples = (w.examples || []).map((e, i) => `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:0.7rem;color:var(--accent);min-width:16px;margin-top:2px">${i+1}.</div>
      <div style="flex:1">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.92rem;color:var(--text);line-height:1.4;margin-bottom:2px;flex:1">${e.fr}</div>
          <button onclick="speakText(this)" data-speak="${escapeAttr(e.fr)}" title="Произнести" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:0.85rem;flex-shrink:0;padding:0">🔊</button>
          ${canEdit ? `<button onclick="editDictExample('prep','${w.id}',${i})" title="Редактировать пример" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:.8rem;padding:0">✏️</button>` : ''}
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${e.ru || '<span style="opacity:.65">перевод не задан</span>'}</div>
      </div>
    </div>`).join('');

  const similar = (w.similar_verbs || []).map(s => `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.88rem">
      <span style="font-family:'Playfair Display',serif;font-style:italic;color:var(--text)">${s.verb} ${s.prep}</span>
      <span style="font-size:0.78rem;color:var(--text-muted)">${s.ru}</span>
    </div>`).join('');

  return `
    <button onclick="renderDictWords('${dictType}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;margin-bottom:14px;padding:0;font-family:'IBM Plex Sans',sans-serif">← Все конструкции</button>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
      <div style="padding:18px 20px 14px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(10,132,255,0.06) 0%,transparent 60%)">
        <div style="font-family:'Playfair Display',serif;font-size:1.8rem;font-weight:600;margin-bottom:4px">${w.verb}</div>
        <div style="font-size:1rem;font-weight:500;margin-bottom:8px">${w.ru || '<span style="color:var(--text-muted)">перевод не задан</span>'}</div>
        ${canEdit ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button onclick="editDictWord('prep','${w.id}')" class="btn btn-secondary" style="padding:5px 9px;font-size:.72rem">✏️ запись</button><button onclick="addDictTranslation('prep','${w.id}')" class="btn btn-secondary" style="padding:5px 9px;font-size:.72rem">+ перевод</button><button onclick="editDictExample('prep','${w.id}',-1)" class="btn btn-secondary" style="padding:5px 9px;font-size:.72rem">+ пример</button></div>` : ''}
        <span style="font-size:0.7rem;padding:2px 8px;border-radius:20px;border:1px solid var(--blue);color:var(--blue)">${w.level||'A2'}</span>
      </div>
      <div style="padding:14px 20px;border-bottom:1px solid var(--border)">
        <div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">🔗 Конструкции</div>
        ${prepsHtml}
      </div>
      ${examples ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">📝 Примеры</div>${examples}</div>` : ''}
      ${w.tip ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px">⚠️ Типичная ошибка</div><div style="font-size:0.85rem;color:var(--text-muted);line-height:1.6">${w.tip}</div></div>` : ''}
      ${similar ? `<div style="padding:14px 20px;border-bottom:1px solid var(--border)"><div style="font-size:0.7rem;font-weight:600;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">🔄 Похожие конструкции</div>${similar}</div>` : ''}
      <div style="padding:14px 20px;display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="setTrainerMode('preps')" style="flex:1;min-width:170px;padding:12px;background:rgba(10,132,255,0.1);border:1px solid var(--blue);border-radius:10px;color:var(--blue);font-family:'IBM Plex Sans',sans-serif;font-weight:600;font-size:0.88rem;cursor:pointer">
          🎯 Тренировать предлоги
        </button>
        ${canEdit ? `<button onclick="editDictWord('prep','${w.id}')" style="padding:12px 14px;background:rgba(10,132,255,0.08);border:1px solid rgba(10,132,255,0.3);border-radius:10px;color:var(--blue);font-family:'IBM Plex Sans',sans-serif;font-size:0.88rem;cursor:pointer" title="Редактировать">✏️</button>` : ''}
        <button onclick="deleteDictWord('prep','${w.id}')" style="padding:12px 14px;background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.3);border-radius:10px;color:var(--bad);font-family:'IBM Plex Sans',sans-serif;font-size:0.88rem;cursor:pointer" title="Удалить">
          🗑
        </button>
      </div>
    </div>`;
}


window.confirmClearNouns = async function() {
  try {
    if (!window.isAdmin || !window.isAdmin()) { showToast('🔒 Очистка доступна только администратору'); return; }
    const n = dictNounsCache.length || 0;
    const first = confirm(`Очистить ВСЕ слова из Firebase /nouns? Сейчас в списке примерно ${n} записей.\n\nГлаголы, предлоги и фразы не трогаю.`);
    if (!first) return;
    const token = prompt('Для подтверждения напиши: ОЧИСТИТЬ');
    if (token !== 'ОЧИСТИТЬ') { showToast('Отменено'); return; }
    showToast('⏳ Очищаю слова...');
    const { error } = await sb.from('nouns').delete();
    if (error) throw error;
    dictNounsCache = [];
    NOUNS.length = 0;
    setNounsLoaded(false);
    try { Object.keys(localStorage).forEach(k => { if (k.includes('nouns') || k.includes('noun')) localStorage.removeItem(k); }); } catch {}
    window.setDictType('nouns');
    showToast('✅ Слова очищены');
  } catch(e) {
    showToast('⚠️ ' + (e?.message || e));
  }
};

function getDictRecord(type, id) {
  const src = type === 'noun' ? dictNounsCache : dictPrepsCache;
  return src.find(x => String(x.id) === String(id));
}

function replaceDictRecord(type, record) {
  const src = type === 'noun' ? dictNounsCache : dictPrepsCache;
  const i = src.findIndex(x => String(x.id) === String(record.id));
  if (i >= 0) src[i] = record;
  else src.unshift(record);
  if (type === 'noun') dictNounsCache = src;
  else dictPrepsCache = src;
}

window.addDictTranslation = async function(type, id) {
  try {
    if (!window.isAdmin || !window.isAdmin()) { showToast('🔒 Только администратор'); return; }
    const rec = getDictRecord(type, id);
    if (!rec) throw new Error('Запись не найдена');
    const current = rec.ru || rec.translations || '';
    const next = prompt('Перевод / переводы через запятую:', current);
    if (next === null) return;
    const updated = { ...rec, ru: next.trim(), translations: next.trim(), updated_at: new Date().toISOString() };
    const table = type === 'noun' ? 'nouns' : 'prepositions';
    const { error } = await sb.from(table).upsert(updated);
    if (error) throw error;
    replaceDictRecord(type, updated);
    showDictWordCard(type, id);
    showToast('✅ Перевод обновлён');
  } catch(e) { showToast('⚠️ ' + (e?.message || e)); }
};

function ensureDictExampleModal() {
  let modal = document.getElementById('dict-example-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'dict-example-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:1002;background:rgba(0,0,0,.76);align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;width:100%;max-width:560px;max-height:90vh;overflow:auto;">
      <div style="font-size:1rem;font-weight:600;color:var(--text);margin-bottom:4px">📝 Пример</div>
      <div style="font-size:.78rem;color:var(--text-muted);line-height:1.45;margin-bottom:14px">Можно добавить французский пример и перевод. Пустой перевод допустим, но лучше не лениться — будущий ты скажет спасибо.</div>
      <input type="hidden" id="dict-example-type"><input type="hidden" id="dict-example-id"><input type="hidden" id="dict-example-index">
      <div style="margin-bottom:10px"><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Французский пример</label><textarea id="dict-example-fr" rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);resize:vertical"></textarea></div>
      <div style="margin-bottom:12px"><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Перевод</label><textarea id="dict-example-ru" rows="2" style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);resize:vertical"></textarea></div>
      <div id="dict-example-status" style="display:none;font-size:.82rem;margin-bottom:12px;text-align:center;padding:8px;border-radius:8px;background:var(--surface2)"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button onclick="closeDictExampleModal()" class="btn btn-secondary" style="flex:1">Отмена</button><button onclick="deleteDictExample()" id="dict-example-delete" class="btn btn-danger" style="display:none;flex:1">Удалить</button><button onclick="saveDictExample()" class="btn btn-primary" style="flex:1">Сохранить</button></div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

window.editDictExample = function(type, id, index = -1) {
  if (!window.isAdmin || !window.isAdmin()) { showToast('🔒 Только администратор'); return; }
  const rec = getDictRecord(type, id);
  if (!rec) { showToast('⚠️ Запись не найдена'); return; }
  const modal = ensureDictExampleModal();
  const ex = index >= 0 ? (rec.examples || [])[index] || {} : {};
  modal.querySelector('#dict-example-type').value = type;
  modal.querySelector('#dict-example-id').value = id;
  modal.querySelector('#dict-example-index').value = String(index);
  modal.querySelector('#dict-example-fr').value = ex.fr || '';
  modal.querySelector('#dict-example-ru').value = ex.ru || '';
  const del = modal.querySelector('#dict-example-delete');
  if (del) del.style.display = index >= 0 ? 'inline-block' : 'none';
  const st = modal.querySelector('#dict-example-status');
  if (st) { st.style.display = 'none'; st.textContent = ''; }
  modal.style.display = 'flex';
};

window.closeDictExampleModal = function() {
  const modal = document.getElementById('dict-example-modal');
  if (modal) modal.style.display = 'none';
};

window.saveDictExample = async function() {
  const modal = ensureDictExampleModal();
  const st = modal.querySelector('#dict-example-status');
  try {
    const type = modal.querySelector('#dict-example-type').value;
    const id = modal.querySelector('#dict-example-id').value;
    const index = Number(modal.querySelector('#dict-example-index').value || -1);
    const fr = modal.querySelector('#dict-example-fr').value.trim();
    const ru = modal.querySelector('#dict-example-ru').value.trim();
    if (!fr) throw new Error('Введи французский пример.');
    const rec = getDictRecord(type, id);
    if (!rec) throw new Error('Запись не найдена.');
    const examples = Array.isArray(rec.examples) ? [...rec.examples] : [];
    const item = { fr, ru, updated_at: new Date().toISOString() };
    if (index >= 0 && examples[index]) examples[index] = { ...examples[index], ...item };
    else examples.push(item);
    const updated = { ...rec, examples, context: examples.map(e => `${e.fr}${e.ru ? ' — ' + e.ru : ''}`).join('\n'), updated_at: new Date().toISOString() };
    const table = type === 'noun' ? 'nouns' : 'prepositions';
    if (st) { st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = '⏳ Сохраняю...'; }
    const { error } = await sb.from(table).upsert(updated);
    if (error) throw error;
    replaceDictRecord(type, updated);
    window.closeDictExampleModal();
    showDictWordCard(type, id);
    showToast('✅ Пример сохранён');
  } catch(e) {
    if (st) { st.style.display = 'block'; st.style.color = 'var(--bad)'; st.textContent = '❌ ' + (e?.message || e); }
    else showToast('⚠️ ' + (e?.message || e));
  }
};

window.deleteDictExample = async function() {
  const modal = ensureDictExampleModal();
  const type = modal.querySelector('#dict-example-type').value;
  const id = modal.querySelector('#dict-example-id').value;
  const index = Number(modal.querySelector('#dict-example-index').value || -1);
  if (index < 0) return;
  if (!confirm('Удалить этот пример?')) return;
  try {
    const rec = getDictRecord(type, id);
    if (!rec) throw new Error('Запись не найдена.');
    const examples = (Array.isArray(rec.examples) ? [...rec.examples] : []).filter((_, i) => i !== index);
    const updated = { ...rec, examples, context: examples.map(e => `${e.fr}${e.ru ? ' — ' + e.ru : ''}`).join('\n'), updated_at: new Date().toISOString() };
    const table = type === 'noun' ? 'nouns' : 'prepositions';
    const { error } = await sb.from(table).upsert(updated);
    if (error) throw error;
    replaceDictRecord(type, updated);
    window.closeDictExampleModal();
    showDictWordCard(type, id);
    showToast('✅ Пример удалён');
  } catch(e) { showToast('⚠️ ' + (e?.message || e)); }
};

window.dictGenerate = async function() {
  const inp = document.getElementById('dict-search');
  const word = inp?.value.trim();
  if (!word) return;

  const btn = document.getElementById('dict-gen-btn');
  const card = document.getElementById('dict-word-card');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерирую...'; }
  if (card) card.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">⏳ DeepSeek создаёт черновик для «${escapeHtml(word)}»...</div>`;

  try {
    const type = dictType === 'preps' ? 'preposition' : 'noun';
    const d = await readerAI({
      task: 'reader_word',
      word,
      surface: word,
      type,
      context: word,
    });
    const pos = d.pos || (type === 'preposition' ? 'preposition' : 'noun');
    const lemma = d.lemma || d.infinitive || d.fr || word;
    const ru = d.ru || d.meaning || d.translation || '';

    if (dictType === 'preps' || pos === 'preposition') {
      const id = normalizeImportKey(lemma);
      const record = {
        id,
        fr: lemma,
        verb: lemma,
        ru,
        level: d.level || 'A2',
        source: 'deepseek_reader_ai',
        custom: true,
        preps: [{ prep: '', meaning: ru, example_fr: '', example_ru: '' }],
        examples: [],
        context: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('prepositions').upsert(record);
      if (error) throw error;
      dictPrepsCache.unshift(record);
      if (card) card.innerHTML = renderPrepCard(record);
      showToast('✅ Конструкция создана через reader-ai');
    } else {
      const id = normalizeImportKey(lemma);
      const record = {
        id,
        fr: lemma,
        ru,
        translations: ru,
        gender: pos === 'verb' ? '' : (d.gender || 'm'),
        level: d.level || 'A2',
        theme: 'deepseek',
        source: 'deepseek_reader_ai',
        custom: true,
        examples: [],
        context: d.note || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from('nouns').upsert(record);
      if (error) throw error;
      dictNounsCache.unshift(record);
      if (card) card.innerHTML = renderNounCard(record);
      showToast(pos === 'verb' ? '⚠️ Это похоже на глагол, сохранил как запись без рода' : '✅ Слово создано через reader-ai');
    }
  } catch(e) {
    if (card) card.innerHTML = `<div style="background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.25);border-radius:12px;padding:16px;color:var(--bad)">❌ reader-ai: ${escapeHtml(e?.message || e)}</div>`;
    showToast('⚠️ reader-ai не сработал');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Создать'; }
  }
};

export function setDictTypeValue(t) { dictType = t; }
export { dictNounsCache, dictPrepsCache, dictType };

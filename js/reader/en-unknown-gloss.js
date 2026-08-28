import { normalizeImportKey } from '../utils.js';

// English Unknown-word glosses for the Migaku-style vocabulary layer.
// Geometry is reserved synchronously before page measurement; network results
// only fill an out-of-flow label and therefore cannot repaginate the chapter.
const MODE_KEY = 'an2_reader_en_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_en_unknown_gloss_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.32';
const MAX_CACHE = 2600;
const MAX_CONCURRENT = 4;
const MAX_ENRICH_CURRENT_PAGE = 28;
const MAX_ENRICH_PREFETCH = 56;
const PREFETCH_PAGE_COUNT = 2;
const MAX_QUEUE = 96;
const RETRY_AFTER_MS = 5 * 60 * 1000;

let appPromise = null;
let scanTimer = null;
let rootObserver = null;
let viewObserver = null;
let activeWorkers = 0;
const queue = [];
const queuedKeys = new Set();
const failedAt = new Map();
const paragraphSourceText = new WeakMap();
const liveWrappersByKey = new Map();

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function currentLang() {
  const lang = String(document.getElementById('reader-reading-view')?.dataset?.readerLang || '').toLowerCase();
  return lang.startsWith('en') ? 'en' : lang;
}

function mode() {
  try { return localStorage.getItem(MODE_KEY) === 'unknown' ? 'unknown' : 'off'; }
  catch { return 'off'; }
}
function enabled() { return mode() === 'unknown'; }
function canonicalApp() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
  catch { return {}; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function textHash(text) {
  const s = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function normalizeSurface(word) {
  return String(word || '').replace(/[’‘]/g, "'").trim().toLocaleLowerCase('en-US');
}
function cacheKey(word, context) {
  return `${normalizeImportKey(normalizeSurface(word))}|${textHash(String(context || '').replace(/\s+/g, ' ').trim().slice(0, 240))}`;
}

function loadOwnCache() { return readJson(scopedKey(CACHE_BASE_KEY)); }
function saveOwnCache(cache) {
  const entries = Object.entries(cache || {});
  if (entries.length > MAX_CACHE) {
    entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
    cache = Object.fromEntries(entries.slice(0, MAX_CACHE));
  }
  writeJson(scopedKey(CACHE_BASE_KEY), cache || {});
  return cache;
}

function lexicalCache() { return readJson(scopedKey('an2_reader_lexical_cache_v1')); }
function lexicalEntry(word, lemma = '', cache = null) {
  const source = cache || lexicalCache();
  const surface = normalizeImportKey(normalizeSurface(word));
  const canonical = normalizeImportKey(normalizeSurface(lemma));
  return source[`en:${surface}`] || (canonical ? source[`en:${canonical}`] : null) || null;
}
function russianMeaning(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.ru || value.translation_ru || value.russian || value.meaning_ru || value.meaning || '').trim();
}
function compactRussian(value) {
  const full = String(value || '').replace(/\s+/g, ' ').trim();
  if (!full) return '';
  const first = full.split(/\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || full;
  if (first.length <= 28) return first;
  const words = first.split(/\s+/).filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 28) break;
    out = next;
  }
  return out || first.slice(0, 28).trim();
}
function glossFontSize(surface, ru) {
  const a = Math.max(2, Array.from(String(surface || '')).length);
  const b = Math.max(1, Array.from(String(ru || '')).length);
  const ratio = b / a;
  const em = Math.max(0.27, Math.min(0.46, 0.47 / Math.sqrt(Math.max(1, ratio))));
  return `${em.toFixed(3)}em`;
}

function isEnglishWordElement(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'en'
    && /[A-Za-z]/.test(String(el.dataset?.word || ''));
}
function wrapperFor(el) {
  const parent = el?.parentElement;
  return parent?.classList?.contains('rw-en-gloss-wrap') ? parent : null;
}
function registerLiveWrapper(key, wrap) {
  if (!key || !wrap) return;
  let set = liveWrappersByKey.get(key);
  if (!set) { set = new Set(); liveWrappersByKey.set(key, set); }
  set.add(wrap);
  wrap.dataset.enGlossKey = key;
}
function lemmaFor(word) {
  try { return String(globalThis.readerEnglishLemmaFor?.(word) || normalizeSurface(word)).trim(); }
  catch { return normalizeSurface(word); }
}
function getParagraphContext(el) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return '';
  if (paragraphSourceText.has(paragraph)) return paragraphSourceText.get(paragraph) || '';
  const source = String(paragraph.querySelector?.('.reader-paragraph-text')?.textContent || paragraph.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  paragraphSourceText.set(paragraph, source);
  return source;
}

function ensureWrapper(el, hint = {}) {
  if (!isEnglishWordElement(el)) return null;
  const word = String(el.dataset.word || '').trim();
  if (!word) return null;
  let wrap = wrapperFor(el);
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-en-gloss-wrap';
    wrap.dataset.enGloss = '1';
    el.parentNode?.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  const ru = compactRussian(hint.ru || '');
  wrap.dataset.enGlossRu = ru;
  wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
  return wrap;
}

function bestCachedHint(word, context, lemma = '', ownCache = null, lexCache = null) {
  const own = (ownCache || loadOwnCache())[cacheKey(word, context)] || null;
  const lexical = lexicalEntry(word, lemma, lexCache) || null;
  return { ru: russianMeaning(own) || russianMeaning(lexical) || '' };
}
function updateVisibleWord(word, context, data = {}) {
  if (!enabled()) return;
  const key = cacheKey(word, context);
  const wraps = liveWrappersByKey.get(key);
  if (!wraps?.size) return;
  const ru = compactRussian(russianMeaning(data));
  for (const wrap of [...wraps]) {
    if (!wrap?.isConnected) { wraps.delete(wrap); continue; }
    if (ru) {
      wrap.dataset.enGlossRu = ru;
      wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
    }
  }
  if (!wraps.size) liveWrappersByKey.delete(key);
}

async function callReaderWord(word, context, lemma = '') {
  const app = await canonicalApp();
  if (typeof app?.readerAI !== 'function') throw new Error('readerAI unavailable');
  const raw = await app.readerAI({
    task: 'reader_word',
    sourceLang: 'en',
    word,
    surface: word,
    lemma: lemma || undefined,
    context,
  });
  return { ru: russianMeaning(raw) };
}
function enqueueEnrichment(word, context, lemma = '', lexEntry = null, priority = 1) {
  if (!enabled() || !word || !context) return;
  const key = cacheKey(word, context);
  const own = loadOwnCache()[key];
  if (own && russianMeaning(own)) return;
  if (russianMeaning(lexEntry || lexicalEntry(word, lemma))) return;
  if (queuedKeys.has(key)) return;
  const failed = Number(failedAt.get(key) || 0);
  if (failed && Date.now() - failed < RETRY_AFTER_MS) return;
  if (queue.length >= MAX_QUEUE && priority > 0) return;
  queuedKeys.add(key);
  const job = { key, word, context, lemma, priority };
  const insertAt = queue.findIndex(item => Number(item.priority || 0) > priority);
  if (insertAt === -1) queue.push(job); else queue.splice(insertAt, 0, job);
  pumpQueue();
}
function pumpQueue() {
  while (enabled() && activeWorkers < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!job) break;
    activeWorkers++;
    (async () => {
      try {
        const data = await callReaderWord(job.word, job.context, job.lemma);
        if (russianMeaning(data)) {
          const cache = loadOwnCache();
          cache[job.key] = { ...data, t: Date.now() };
          saveOwnCache(cache);
          updateVisibleWord(job.word, job.context, data);
        }
      } catch (error) {
        failedAt.set(job.key, Date.now());
        console.warn('[en unknown gloss] enrichment failed:', job.word, error?.message || error);
      } finally {
        queuedKeys.delete(job.key);
        activeWorkers--;
        pumpQueue();
      }
    })();
  }
}

function injectStyles() {
  if (document.getElementById('rd-en-unknown-gloss-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-en-unknown-gloss-style';
  style.textContent = `
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .reader-paragraph-text {
      line-height: 1.86 !important;
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap {
      display:inline-grid !important;
      grid-template-rows:1.04em .52em !important;
      grid-template-columns:max-content !important;
      align-items:center !important;
      justify-items:center !important;
      vertical-align:-.34em !important;
      line-height:1 !important;
      margin:0 .025em !important;
      padding:0 !important;
      position:relative !important;
      overflow:visible !important;
      white-space:nowrap !important;
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap > .reader-word {
      grid-row:1 !important;
      grid-column:1 !important;
      display:inline !important;
      margin:0 !important;
      padding:0 1px !important;
      line-height:1.04 !important;
      white-space:nowrap !important;
      word-break:keep-all !important;
      overflow-wrap:normal !important;
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap::after {
      grid-row:2 !important;
      grid-column:1 !important;
      align-self:start !important;
      justify-self:stretch !important;
      width:100% !important;
      min-width:0 !important;
      max-width:100% !important;
      overflow:hidden !important;
      white-space:nowrap !important;
      text-align:center !important;
      pointer-events:none !important;
      font-family:'IBM Plex Sans',sans-serif !important;
      font-size:var(--en-gloss-font,.38em) !important;
      font-weight:400 !important;
      line-height:1 !important;
      color:var(--text-muted) !important;
      content:'';
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap:has(> .rw-migaku-unknown)::after {
      content:attr(data-en-gloss-ru) !important;
    }
  `;
  document.head.appendChild(style);
}

function ensureControl() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return null;
  let row = document.getElementById('rd-dp-en-unknown-gloss-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'rd-dp-en-unknown-gloss-row';
    row.className = 'rd-dp-row';
    row.style.display = 'none';
    row.innerHTML = `
      <span class="rd-dp-label">English · Unknown words</span>
      <div class="rd-dp-pills">
        <button type="button" class="rd-dp-pill rd-en-gloss-mode" data-mode="off">Обычный текст</button>
        <button type="button" class="rd-dp-pill rd-en-gloss-mode" data-mode="unknown">Русский под Unknown</button>
      </div>`;
    row.querySelectorAll('.rd-en-gloss-mode').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.mode || 'off'));
    });
    panel.appendChild(row);
  }
  return row;
}
function syncControl() {
  const row = ensureControl();
  const view = document.getElementById('reader-reading-view');
  if (!row || !view) return;
  const isEn = currentLang() === 'en';
  row.style.display = isEn ? 'flex' : 'none';
  row.querySelectorAll('.rd-en-gloss-mode').forEach(button => {
    button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
  });
  view.classList.toggle('rd-en-unknown-gloss', isEn && enabled());
}

async function setMode(next) {
  const value = next === 'unknown' ? 'unknown' : 'off';
  try { localStorage.setItem(MODE_KEY, value); } catch {}
  syncControl();
  try {
    const app = await canonicalApp();
    app.renderReaderChapter?.();
  } catch (error) {
    console.warn('[en unknown gloss] reader refresh skipped:', error?.message || error);
  }
  scheduleScan(60);
}

function prepareStableSlots(root = document.getElementById('reader-chapter-text')) {
  injectStyles();
  syncControl();
  if (!enabled() || currentLang() !== 'en' || !root) return 0;
  const ownCache = loadOwnCache();
  const lexCache = lexicalCache();
  let prepared = 0;
  root.querySelectorAll('.reader-word[data-lang="en"][data-word]').forEach(el => {
    if (!isEnglishWordElement(el)) return;
    const word = String(el.dataset.word || '').trim();
    const lemma = lemmaFor(word);
    const context = getParagraphContext(el);
    const hint = bestCachedHint(word, context, lemma, ownCache, lexCache);
    if (ensureWrapper(el, hint)) prepared++;
  });
  return prepared;
}

function isVisibleWord(el) {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const bottom = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    return rect.bottom >= 0 && rect.top <= bottom;
  } catch { return true; }
}
function scheduleScan(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}
function scan() {
  syncControl();
  if (!enabled() || currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  prepareStableSlots(root);

  const ownCache = loadOwnCache();
  const lexCache = lexicalCache();
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  let currentPageIndex = pages.findIndex(page => page.classList.contains('rd-page-current') || page.classList.contains('rd-page-show'));
  if (currentPageIndex < 0) currentPageIndex = 0;
  const pageMode = pages.length > 0;
  const scopes = pageMode ? pages.slice(currentPageIndex, currentPageIndex + PREFETCH_PAGE_COUNT + 1) : [root];
  let queuedCurrent = 0;
  let queuedPrefetch = 0;

  for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
    const words = Array.from(scopes[scopeIndex].querySelectorAll('.reader-word[data-lang="en"][data-word]'));
    for (const el of words) {
      if (!isEnglishWordElement(el)) continue;
      const word = String(el.dataset.word || '').trim();
      const lemma = lemmaFor(word);
      const context = getParagraphContext(el);
      const key = cacheKey(word, context);
      const lexical = lexicalEntry(word, lemma, lexCache);
      const hint = bestCachedHint(word, context, lemma, ownCache, lexCache);
      const wrap = ensureWrapper(el, hint);
      if (!wrap) continue;
      registerLiveWrapper(key, wrap);

      // Only the binary Migaku Unknown state gets an inline translation.
      if (!el.classList.contains('rw-migaku-unknown')) {
        wrap.dataset.enGlossRu = '';
        continue;
      }
      if (hint.ru) {
        const ru = compactRussian(hint.ru);
        wrap.dataset.enGlossRu = ru;
        wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
        continue;
      }

      if (pageMode) {
        if (scopeIndex === 0) {
          if (queuedCurrent >= MAX_ENRICH_CURRENT_PAGE) continue;
          queuedCurrent++;
          enqueueEnrichment(word, context, lemma, lexical, 0);
        } else {
          if (queuedPrefetch >= MAX_ENRICH_PREFETCH) continue;
          queuedPrefetch++;
          enqueueEnrichment(word, context, lemma, lexical, scopeIndex);
        }
      } else if (queuedCurrent < MAX_ENRICH_CURRENT_PAGE && isVisibleWord(el)) {
        queuedCurrent++;
        enqueueEnrichment(word, context, lemma, lexical, 0);
      }
    }
  }
}

function installObservers() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || typeof MutationObserver === 'undefined') return;
  injectStyles();
  ensureControl();
  syncControl();
  const root = document.getElementById('reader-chapter-text');
  if (root && !rootObserver) {
    rootObserver = new MutationObserver(() => scheduleScan(35));
    rootObserver.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
  }
  const view = document.getElementById('reader-reading-view');
  if (view && !viewObserver) {
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(35); });
    viewObserver.observe(view, { attributes:true, attributeFilter:['data-reader-lang','style','class'] });
  }
  scheduleScan(0);
}

if (typeof window !== 'undefined') {
  window.readerSetEnUnknownGlossMode = setMode;
  window.readerGetEnUnknownGlossMode = mode;
  window.readerPrepareEnStableSlots = prepareStableSlots;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installObservers, { once:true });
  else installObservers();
  window.addEventListener('pageshow', () => { installObservers(); scheduleScan(60); });
  window.addEventListener('reader:en-vocab-ready', () => scheduleScan(20));
}

export { mode, enabled, compactRussian, cacheKey, prepareStableSlots };

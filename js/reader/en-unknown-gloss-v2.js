import { normalizeImportKey } from '../utils.js';

// English Unknown glosses v3.
// Goals: (1) a resolved gloss never disappears during transient classifier DOM
// passes; (2) page N+1/N+2 prefetch cannot be starved by a huge paragraph on N;
// (3) late native translation text never changes pagination geometry;
// (4) missing glosses never call DeepSeek or open another Android app.
const MODE_KEY = 'an2_reader_en_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_en_unknown_gloss_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.31';
const INSTANT_WORD_CACHE_KEY = 'an2_instant_translate_word_cache_v1';
const MAX_CACHE = 2600;
const MAX_CONCURRENT = 1;
const MAX_CURRENT = 28;
const MAX_PREFETCH = 56;
const PREFETCH_PAGES = 2;
const HEAD_CURRENT = 4;
const HEAD_NEXT = 8;
const MAX_QUEUE = 96;
const RETRY_AFTER_MS = 90 * 1000;
const NATIVE_TIMEOUT_MS = 55 * 1000;

let appPromise = null;
let scanTimer = null;
let rootObserver = null;
let rootObserved = null;
let viewObserver = null;
let viewObserved = null;
let activeWorkers = 0;
let nativeSequence = 0;
const queue = [];
const queuedKeys = new Set();
const failedAt = new Map();
const paragraphSourceText = new WeakMap();
const liveWrappersByKey = new Map();
const nativePending = new Map();

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}
function currentLang() {
  const lang = String(document.getElementById('reader-reading-view')?.dataset?.readerLang || '').toLowerCase();
  return lang.startsWith('en') ? 'en' : lang;
}
function mode() {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    // Before v3 the missing key behaved as OFF even though the feature was
    // intended to mirror Chinese Unknown assistance. Keep an explicit user OFF,
    // but make a fresh install / untouched profile useful immediately.
    return stored === 'off' ? 'off' : 'unknown';
  } catch { return 'unknown'; }
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
function normalizeSurface(word) {
  return String(word || '').replace(/[’‘]/g, "'").trim().toLocaleLowerCase('en-US');
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
function cacheKey(word, context) {
  const cleanContext = String(context || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${normalizeImportKey(normalizeSurface(word))}|${textHash(cleanContext)}`;
}
function russianMeaning(data = {}) {
  if (typeof data === 'string') return data.trim();
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
function ownCache() { return readJson(scopedKey(CACHE_BASE_KEY)); }
function saveOwnCache(cache) {
  let entries = Object.entries(cache || {});
  if (entries.length > MAX_CACHE) {
    entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
    entries = entries.slice(0, MAX_CACHE);
    cache = Object.fromEntries(entries);
  }
  writeJson(scopedKey(CACHE_BASE_KEY), cache || {});
}
function lexicalCache() { return readJson(scopedKey('an2_reader_lexical_cache_v1')); }
function instantWordCache() { return readJson(INSTANT_WORD_CACHE_KEY); }
function lemmaFor(word) {
  try { return String(globalThis.readerEnglishLemmaFor?.(word) || normalizeSurface(word)).trim(); }
  catch { return normalizeSurface(word); }
}
function lexicalEntry(word, lemma = '', source = null) {
  const cache = source || lexicalCache();
  const surface = normalizeImportKey(normalizeSurface(word));
  const canonical = normalizeImportKey(normalizeSurface(lemma));
  return cache[`en:${surface}`] || (canonical ? cache[`en:${canonical}`] : null) || null;
}
function instantEntry(word, lemma = '', source = null) {
  const cache = source || instantWordCache();
  const surface = normalizeSurface(word);
  const canonical = normalizeSurface(lemma);
  return cache[`en:${surface}`] || (canonical ? cache[`en:${canonical}`] : null) || null;
}
function bestHint(word, context, lemma, own, lexical, instant) {
  const direct = own?.[cacheKey(word, context)] || null;
  return compactRussian(
    russianMeaning(direct)
    || russianMeaning(instantEntry(word, lemma, instant))
    || russianMeaning(lexicalEntry(word, lemma, lexical))
  );
}
function isEnglishWord(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'en'
    && /[A-Za-z]/.test(String(el.dataset?.word || ''));
}
function knowledge(el) {
  // Missing both classes is transient/pending, never an instruction to erase.
  if (el?.classList?.contains('rw-migaku-unknown')) return 'unknown';
  if (el?.classList?.contains('rw-migaku-known')) return 'known';
  return '';
}
function paragraphContext(el) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return '';
  if (paragraphSourceText.has(paragraph)) return paragraphSourceText.get(paragraph) || '';
  const source = String(paragraph.querySelector?.('.reader-paragraph-text')?.textContent || paragraph.textContent || '')
    .replace(/\s+/g, ' ').trim();
  paragraphSourceText.set(paragraph, source);
  return source;
}
function wrapperFor(el) {
  return el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
}
function syncVisibility(el, wrap) {
  const state = knowledge(el);
  if (state === 'unknown') wrap.dataset.enGlossVisible = '1';
  else if (state === 'known') wrap.dataset.enGlossVisible = '0';
  // pending => sticky; keep the last confirmed state.
  return state;
}
function ensureWrapper(el, ru = '') {
  if (!isEnglishWord(el)) return null;
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
  const compact = compactRussian(ru);
  if (compact) {
    wrap.dataset.enGlossRu = compact;
    wrap.dataset.enGlossStickyRu = compact;
    wrap.style.setProperty('--en-gloss-font', glossFontSize(word, compact));
  } else if (!Object.prototype.hasOwnProperty.call(wrap.dataset, 'enGlossRu')) {
    wrap.dataset.enGlossRu = '';
    wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ''));
  }
  syncVisibility(el, wrap);
  return wrap;
}
function registerWrapper(key, wrap) {
  if (!key || !wrap) return;
  let set = liveWrappersByKey.get(key);
  if (!set) { set = new Set(); liveWrappersByKey.set(key, set); }
  set.add(wrap);
}

function nativeTranslate(words) {
  return new Promise((resolve, reject) => {
    const bridge = globalThis.ReaderOfflineTranslate;
    if (!bridge || typeof bridge.translateBatch !== 'function') {
      reject(new Error('ReaderOfflineTranslate unavailable'));
      return;
    }
    const clean = [...new Set((words || []).map(normalizeSurface).filter(Boolean))].slice(0, 4);
    if (!clean.length) { resolve({}); return; }
    const requestId = `enru-${Date.now().toString(36)}-${(++nativeSequence).toString(36)}`;
    const timer = setTimeout(() => {
      nativePending.delete(requestId);
      reject(new Error('EN→RU offline model timeout'));
    }, NATIVE_TIMEOUT_MS);
    nativePending.set(requestId, { resolve, reject, timer });
    try {
      bridge.translateBatch(requestId, JSON.stringify(clean));
    } catch (error) {
      clearTimeout(timer);
      nativePending.delete(requestId);
      reject(error);
    }
  });
}

if (typeof window !== 'undefined') {
  window.__readerOfflineTranslateResolve = (requestId, ok, payloadJson) => {
    const pending = nativePending.get(String(requestId || ''));
    if (!pending) return;
    nativePending.delete(String(requestId || ''));
    clearTimeout(pending.timer);
    let payload = {};
    try { payload = JSON.parse(String(payloadJson || '{}')) || {}; } catch {}
    if (ok) pending.resolve(payload.translations && typeof payload.translations === 'object' ? payload.translations : {});
    else pending.reject(new Error(String(payload.message || 'EN→RU offline translation failed')));
  };
}

async function callReaderWord(word, context, lemma) {
  // Context stays in the cache key so a manually corrected meaning can remain
  // context-specific, but the fast inline fallback itself is an offline lexical
  // translation. Prefer the lemma (went→go) and keep the surface as fallback.
  const surface = normalizeSurface(word);
  const canonical = normalizeSurface(lemma || surface);
  const translations = await nativeTranslate(canonical === surface ? [surface] : [canonical, surface]);
  return compactRussian(translations[canonical] || translations[surface] || '');
}
function updateLive(key, word, ru) {
  const wraps = liveWrappersByKey.get(key);
  if (!wraps?.size) return;
  for (const wrap of [...wraps]) {
    if (!wrap?.isConnected) { wraps.delete(wrap); continue; }
    const el = wrap.querySelector?.(':scope > .reader-word');
    const state = syncVisibility(el, wrap);
    if (ru) {
      wrap.dataset.enGlossRu = ru;
      wrap.dataset.enGlossStickyRu = ru;
      wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
      if (state !== 'known') wrap.dataset.enGlossVisible = '1';
    }
  }
  if (!wraps.size) liveWrappersByKey.delete(key);
}
function enqueue(job, priority) {
  if (!enabled() || !job?.word || !job?.context) return;
  const key = job.key || cacheKey(job.word, job.context);
  const cached = ownCache()[key];
  if (russianMeaning(cached) || russianMeaning(job.instant) || russianMeaning(job.lexical)) return;
  if (queuedKeys.has(key)) return;
  const failed = Number(failedAt.get(key) || 0);
  if (failed && Date.now() - failed < RETRY_AFTER_MS) return;
  if (queue.length >= MAX_QUEUE && priority > 0) return;
  queuedKeys.add(key);
  const item = { ...job, key, priority };
  const at = queue.findIndex(other => Number(other.priority || 0) > priority);
  if (at < 0) queue.push(item); else queue.splice(at, 0, item);
  pump();
}
function pump() {
  while (enabled() && activeWorkers < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    activeWorkers++;
    (async () => {
      try {
        const ru = await callReaderWord(job.word, job.context, job.lemma);
        if (ru) {
          const cache = ownCache();
          cache[job.key] = { ru, t: Date.now(), provider: 'mlkit_offline_en_ru' };
          saveOwnCache(cache);
          updateLive(job.key, job.word, ru);
        }
      } catch (error) {
        failedAt.set(job.key, Date.now());
        console.warn('[en unknown gloss v3] offline enrichment failed:', job.word, error?.message || error);
      } finally {
        queuedKeys.delete(job.key);
        activeWorkers--;
        pump();
      }
    })();
  }
}

function injectStyles() {
  if (document.getElementById('rd-en-unknown-gloss-style-v2')) return;
  const style = document.createElement('style');
  style.id = 'rd-en-unknown-gloss-style-v2';
  style.textContent = `
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .reader-paragraph-text{line-height:1.86!important}
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap{
      display:inline-block!important;vertical-align:-.34em!important;line-height:1!important;
      margin:0 .025em!important;padding:0 0 .52em!important;position:relative!important;
      overflow:visible!important;white-space:nowrap!important
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap>.reader-word{
      display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;
      white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap::after{
      position:absolute!important;left:0!important;right:0!important;bottom:0!important;top:auto!important;
      width:100%!important;min-width:0!important;max-width:100%!important;height:.52em!important;
      overflow:hidden!important;white-space:nowrap!important;text-align:center!important;pointer-events:none!important;
      font-family:'IBM Plex Sans',sans-serif!important;font-size:var(--en-gloss-font,.38em)!important;
      font-weight:400!important;line-height:1!important;color:var(--text-muted)!important;content:''
    }
    #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap[data-en-gloss-visible="1"]::after{
      content:attr(data-en-gloss-sticky-ru)!important
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
    row.innerHTML = `<span class="rd-dp-label">English · Unknown words</span><div class="rd-dp-pills"><button type="button" class="rd-dp-pill rd-en-gloss-mode" data-mode="off">Обычный текст</button><button type="button" class="rd-dp-pill rd-en-gloss-mode" data-mode="unknown">Русский под Unknown</button></div>`;
    row.querySelectorAll('.rd-en-gloss-mode').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
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
  row.querySelectorAll('.rd-en-gloss-mode').forEach(button => button.classList.toggle('rd-dp-active', button.dataset.mode === mode()));
  view.classList.toggle('rd-en-unknown-gloss', isEn && enabled());
}
async function setMode(next) {
  try { localStorage.setItem(MODE_KEY, next === 'unknown' ? 'unknown' : 'off'); } catch {}
  syncControl();
  try { (await canonicalApp()).renderReaderChapter?.(); }
  catch (error) { console.warn('[en unknown gloss v3] refresh skipped:', error?.message || error); }
  scheduleScan(30);
}

function prepareStableSlots(root = document.getElementById('reader-chapter-text')) {
  injectStyles(); syncControl();
  if (!enabled() || currentLang() !== 'en' || !root) return 0;
  const own = ownCache();
  const lexical = lexicalCache();
  const instant = instantWordCache();
  let count = 0;
  root.querySelectorAll('.reader-word[data-lang="en"][data-word]').forEach(el => {
    const word = String(el.dataset.word || '').trim();
    if (!word) return;
    const ru = bestHint(word, paragraphContext(el), lemmaFor(word), own, lexical, instant);
    if (ensureWrapper(el, ru)) count++;
  });
  return count;
}
function isVisibleWord(el) {
  try {
    const r = el.getBoundingClientRect();
    const h = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.top <= h;
  } catch { return true; }
}
function enqueueSlice(items, start, end, priority) {
  for (const job of items.slice(start, end)) enqueue(job, priority);
}
function scan() {
  syncControl();
  if (!enabled() || currentLang() !== 'en') return;
  pump();
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  prepareStableSlots(root);

  const own = ownCache();
  const lexical = lexicalCache();
  const instant = instantWordCache();
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  if (current < 0) current = 0;
  const pageMode = pages.length > 0;
  const scopes = pageMode ? pages.slice(current, current + PREFETCH_PAGES + 1) : [root];
  const pending = scopes.map(() => []);

  for (let si = 0; si < scopes.length; si++) {
    const words = scopes[si].querySelectorAll('.reader-word[data-lang="en"][data-word]');
    for (const el of words) {
      if (!isEnglishWord(el)) continue;
      const word = String(el.dataset.word || '').trim();
      const lemma = lemmaFor(word);
      const context = paragraphContext(el);
      const key = cacheKey(word, context);
      const lexicalHit = lexicalEntry(word, lemma, lexical);
      const instantHit = instantEntry(word, lemma, instant);
      const ru = bestHint(word, context, lemma, own, lexical, instant);
      const wrap = ensureWrapper(el, ru);
      if (!wrap) continue;
      registerWrapper(key, wrap);
      const state = syncVisibility(el, wrap);
      if (state === 'known') continue;
      if (state !== 'unknown') continue;
      if (ru) {
        wrap.dataset.enGlossRu = ru;
        wrap.dataset.enGlossStickyRu = ru;
        wrap.dataset.enGlossVisible = '1';
        wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
        continue;
      }
      if (!pageMode && !isVisibleWord(el)) continue;
      pending[si].push({ key, word, lemma, context, lexical: lexicalHit, instant: instantHit });
    }
  }

  if (!pageMode) {
    enqueueSlice(pending[0] || [], 0, MAX_CURRENT, 0);
    return;
  }

  const here = pending[0] || [];
  // Start one local current-page job, then queue the top of N+1/N+2 before the
  // rest of a giant paragraph. Native ML Kit is serial on purpose: unlike the
  // old DeepSeek path it is fast after model warm-up and cannot flood the A54.
  enqueueSlice(here, 0, Math.min(HEAD_CURRENT, here.length), 0);
  let prefetched = 0;
  for (let si = 1; si < pending.length; si++) {
    const list = pending[si] || [];
    const take = Math.min(HEAD_NEXT, list.length, MAX_PREFETCH - prefetched);
    enqueueSlice(list, 0, take, si);
    prefetched += take;
  }
  enqueueSlice(here, Math.min(HEAD_CURRENT, here.length), Math.min(MAX_CURRENT, here.length), PREFETCH_PAGES + 1);
  for (let si = 1; si < pending.length && prefetched < MAX_PREFETCH; si++) {
    const list = pending[si] || [];
    const start = Math.min(HEAD_NEXT, list.length);
    const take = Math.min(list.length - start, MAX_PREFETCH - prefetched);
    enqueueSlice(list, start, start + take, PREFETCH_PAGES + 1 + si);
    prefetched += take;
  }
}
function scheduleScan(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}
function scanNow() { clearTimeout(scanTimer); scan(); }
function bindObservers() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== rootObserved) {
    rootObserver?.disconnect();
    rootObserved = root;
    rootObserver = new MutationObserver(records => {
      const urgent = records.some(record => {
        const target = record.target instanceof Element ? record.target : null;
        if (record.type === 'attributes' && target?.classList?.contains('rd-page')) return true;
        return Array.from(record.addedNodes || []).some(node => node instanceof Element && (node.classList.contains('rd-page') || node.querySelector?.('.rd-page')));
      });
      if (urgent) queueMicrotask(scanNow); else scheduleScan(25);
    });
    rootObserver.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
  }
  const view = document.getElementById('reader-reading-view');
  if (view && view !== viewObserved) {
    viewObserver?.disconnect();
    viewObserved = view;
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(25); });
    viewObserver.observe(view, { attributes:true, attributeFilter:['data-reader-lang','style','class'] });
  }
}
function boot() {
  injectStyles(); ensureControl(); syncControl(); bindObservers(); scheduleScan(0);
}

const shouldInstall = typeof window !== 'undefined' && !window.__readerEnUnknownGlossV3Installed;
if (shouldInstall) {
  window.__readerEnUnknownGlossV3Installed = true;
  window.readerSetEnUnknownGlossMode = setMode;
  window.readerGetEnUnknownGlossMode = mode;
  window.readerPrepareEnStableSlots = prepareStableSlots;
  window.readerPrefetchEnUnknownGloss = scanNow;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
  window.addEventListener('pageshow', () => { boot(); scheduleScan(30); });
  window.addEventListener('reader:en-vocab-ready', () => scheduleScan(10));
}

export { mode, enabled, compactRussian, cacheKey, prepareStableSlots };

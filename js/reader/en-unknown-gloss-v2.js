import { normalizeImportKey } from '../utils.js';

// English Unknown glosses v4.
// The visual layer stays independent from the frozen Chinese renderer.
// Missing EN glosses are translated in-process by ML Kit EN→RU; native progress
// is applied straight back to the current DOM so a page rebuild cannot swallow
// a translation that finished a moment later.
const MODE_KEY = 'an2_reader_en_unknown_gloss_mode_v1';
const LEGACY_CACHE_BASE_KEY = 'an2_reader_en_unknown_gloss_cache_v1';
const LEMMA_CACHE_BASE_KEY = 'an2_reader_en_unknown_gloss_lemma_cache_v1';
const INSTANT_WORD_CACHE_KEY = 'an2_instant_translate_word_cache_v1';
const MAX_LEMMA_CACHE = 6000;
const MAX_BATCH = 24;
const NATIVE_TIMEOUT_MS = 90 * 1000;
const RETRY_AFTER_MS = 45 * 1000;
const PREFETCH_PAGES = 2;

let scanTimer = null;
let rootObserver = null;
let rootObserved = null;
let viewObserver = null;
let viewObserved = null;
let nativeSequence = 0;
let batchInFlight = false;
let retryAfter = 0;
const nativePending = new Map();
const paragraphSourceText = new WeakMap();

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).trim().toLowerCase();
  return raw === 'english' || raw === 'en' || raw.startsWith('en-') ? 'en' : raw;
}

function mode() {
  try { return localStorage.getItem(MODE_KEY) === 'off' ? 'off' : 'unknown'; }
  catch { return 'unknown'; }
}
function enabled() { return mode() === 'unknown'; }

function readJson(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value || {})); return true; }
  catch { return false; }
}

function normalizeSurface(word) {
  return String(word || '').replace(/[’‘]/g, "'").trim().toLocaleLowerCase('en-US');
}
function normalizedKey(word) {
  return normalizeImportKey(normalizeSurface(word));
}
function containsCyrillic(value) {
  return /[\u0400-\u052f]/.test(String(value || ''));
}
function compactRussian(value) {
  const full = String(value || '').replace(/\s+/g, ' ').trim();
  if (!full || !containsCyrillic(full)) return '';
  const first = full.split(/\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || full;
  if (first.length <= 30) return first;
  const words = first.split(/\s+/).filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 30) break;
    out = next;
  }
  return out || first.slice(0, 30).trim();
}
function glossFontSize(surface, ru) {
  const sourceLength = Math.max(2, Array.from(String(surface || '')).length);
  const ruLength = Math.max(1, Array.from(String(ru || '')).length);
  const ratio = ruLength / sourceLength;
  const em = Math.max(0.27, Math.min(0.46, 0.47 / Math.sqrt(Math.max(1, ratio))));
  return `${em.toFixed(3)}em`;
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
function legacyCacheKey(word, context) {
  const cleanContext = String(context || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${normalizedKey(word)}|${textHash(cleanContext)}`;
}

function lemmaCache() { return readJson(scopedKey(LEMMA_CACHE_BASE_KEY)); }
function saveLemmaCache(cache) {
  let entries = Object.entries(cache || {});
  if (entries.length > MAX_LEMMA_CACHE) {
    entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
    entries = entries.slice(0, MAX_LEMMA_CACHE);
  }
  writeJson(scopedKey(LEMMA_CACHE_BASE_KEY), Object.fromEntries(entries));
}
function legacyCache() { return readJson(scopedKey(LEGACY_CACHE_BASE_KEY)); }
function lexicalCache() { return readJson(scopedKey('an2_reader_lexical_cache_v1')); }
function instantWordCache() { return readJson(INSTANT_WORD_CACHE_KEY); }

function russianMeaning(data) {
  if (typeof data === 'string') return data.trim();
  const value = data && typeof data === 'object' ? data : {};
  return String(value.ru || value.translation_ru || value.russian || value.meaning_ru || value.meaning || '').trim();
}
function lemmaFor(word) {
  try {
    const value = globalThis.readerEnglishLemmaFor?.(word);
    return normalizeSurface(value || word);
  } catch { return normalizeSurface(word); }
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
function lexicalEntry(word, lemma, cache) {
  const source = cache || lexicalCache();
  const surfaceKey = normalizedKey(word);
  const lemmaKey = normalizedKey(lemma);
  return source[`en:${surfaceKey}`] || source[`en:${lemmaKey}`] || null;
}
function instantEntry(word, lemma, cache) {
  const source = cache || instantWordCache();
  const surface = normalizeSurface(word);
  const canonical = normalizeSurface(lemma);
  return source[`en:${surface}`] || source[`en:${canonical}`] || null;
}
function bestHint(word, context, lemma, caches = {}) {
  const canonical = normalizedKey(lemma || word);
  const byLemma = caches.lemmas?.[canonical];
  const byInstant = instantEntry(word, lemma, caches.instant);
  const byLexical = lexicalEntry(word, lemma, caches.lexical);
  const byContext = caches.legacy?.[legacyCacheKey(word, context)];
  return compactRussian(
    russianMeaning(byLemma)
    || russianMeaning(byInstant)
    || russianMeaning(byLexical)
    || russianMeaning(byContext),
  );
}

function isEnglishWord(el) {
  if (!el?.classList?.contains('reader-word')) return false;
  const text = String(el.dataset?.word || el.textContent || '');
  return /[A-Za-z]/.test(text);
}
function knowledge(el) {
  if (el?.classList?.contains('rw-migaku-unknown')) return 'unknown';
  if (el?.classList?.contains('rw-migaku-known')) return 'known';
  return '';
}
function wrapperFor(el) {
  return el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
}
function syncVisibility(el, wrap) {
  const state = knowledge(el);
  if (state === 'unknown') wrap.dataset.enGlossVisible = '1';
  else if (state === 'known') wrap.dataset.enGlossVisible = '0';
  return state;
}
function ensureWrapper(el, ru = '') {
  if (!isEnglishWord(el)) return null;
  const word = String(el.dataset.word || el.textContent || '').trim();
  if (!word) return null;
  let wrap = wrapperFor(el);
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-en-gloss-wrap';
    wrap.dataset.enGloss = '1';
    el.parentNode?.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  setWrapperTranslation(wrap, word, ru);
  syncVisibility(el, wrap);
  return wrap;
}
function setWrapperTranslation(wrap, word, value) {
  if (!wrap) return;
  const ru = compactRussian(value);
  if (!ru) return;
  wrap.dataset.enGlossRu = ru;
  wrap.dataset.enGlossStickyRu = ru;
  wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
}

function rememberNativeTranslation(sourceWord, ru) {
  const translation = compactRussian(ru);
  const key = normalizedKey(sourceWord);
  if (!key || !translation) return false;
  const cache = lemmaCache();
  cache[key] = { ru: translation, t: Date.now(), provider: 'mlkit_offline_en_ru' };
  saveLemmaCache(cache);
  return true;
}

function applyTranslationToDom(sourceWord, ru) {
  const translation = compactRussian(ru);
  const sourceKey = normalizedKey(sourceWord);
  const root = document.getElementById('reader-chapter-text');
  if (!translation || !sourceKey || !root || currentLang() !== 'en') return 0;
  let count = 0;
  for (const el of root.querySelectorAll('.reader-word[data-word]')) {
    if (!isEnglishWord(el) || knowledge(el) === 'known') continue;
    const surface = String(el.dataset.word || el.textContent || '').trim();
    const lemma = lemmaFor(surface);
    if (normalizedKey(surface) !== sourceKey && normalizedKey(lemma) !== sourceKey) continue;
    const wrap = ensureWrapper(el, translation);
    if (!wrap) continue;
    setWrapperTranslation(wrap, surface, translation);
    if (knowledge(el) === 'unknown') wrap.dataset.enGlossVisible = '1';
    count++;
  }
  return count;
}

function nativeTranslate(words) {
  return new Promise((resolve, reject) => {
    const bridge = globalThis.ReaderOfflineTranslate;
    if (!bridge || typeof bridge.translateBatch !== 'function') {
      reject(new Error('ReaderOfflineTranslate unavailable'));
      return;
    }
    const clean = [...new Set((words || []).map(normalizeSurface).filter(Boolean))].slice(0, MAX_BATCH);
    if (!clean.length) { resolve({}); return; }
    const requestId = `enru-${Date.now().toString(36)}-${(++nativeSequence).toString(36)}`;
    const timer = setTimeout(() => {
      nativePending.delete(requestId);
      reject(new Error('EN→RU offline translator timeout'));
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
  // Native sends each completed word immediately. This is intentionally outside
  // the install guard: a restored WebView must always have a live callback.
  window.__readerOfflineTranslateProgress = (requestId, sourceWord, translated) => {
    const pending = nativePending.get(String(requestId || ''));
    if (!pending) return;
    const ru = compactRussian(translated);
    if (!ru) return;
    rememberNativeTranslation(sourceWord, ru);
    applyTranslationToDom(sourceWord, ru);
  };

  window.__readerOfflineTranslateResolve = (requestId, ok, payloadJson) => {
    const id = String(requestId || '');
    const pending = nativePending.get(id);
    if (!pending) return;
    nativePending.delete(id);
    clearTimeout(pending.timer);
    let payload = {};
    try { payload = JSON.parse(String(payloadJson || '{}')) || {}; } catch {}
    if (ok) {
      const translations = payload.translations && typeof payload.translations === 'object'
        ? payload.translations : {};
      for (const [sourceWord, value] of Object.entries(translations)) {
        const ru = compactRussian(value);
        if (!ru) continue;
        rememberNativeTranslation(sourceWord, ru);
        applyTranslationToDom(sourceWord, ru);
      }
      pending.resolve(translations);
    } else {
      pending.reject(new Error(String(payload.message || 'EN→RU offline translation failed')));
    }
  };
}

function injectStyles() {
  const old = document.getElementById('rd-en-unknown-gloss-style-v2');
  if (old) old.remove();
  if (document.getElementById('rd-en-unknown-gloss-style-v4')) return;
  const style = document.createElement('style');
  style.id = 'rd-en-unknown-gloss-style-v4';
  style.textContent = `
    #reader-reading-view.rd-en-unknown-gloss .reader-paragraph-text{line-height:1.86!important}
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap{
      display:inline-block!important;vertical-align:-.34em!important;line-height:1!important;
      margin:0 .025em!important;padding:0 0 .52em!important;position:relative!important;
      overflow:visible!important;white-space:nowrap!important
    }
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap>.reader-word{
      display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;
      white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important
    }
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap::after{
      position:absolute!important;left:0!important;right:0!important;bottom:0!important;top:auto!important;
      width:100%!important;min-width:0!important;max-width:100%!important;height:.52em!important;
      overflow:visible!important;white-space:nowrap!important;text-align:center!important;pointer-events:none!important;
      font-family:'IBM Plex Sans',sans-serif!important;font-size:var(--en-gloss-font,.38em)!important;
      font-weight:400!important;line-height:1!important;color:var(--text-muted)!important;content:''
    }
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap[data-en-gloss-visible="1"]::after{
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
    row.querySelectorAll('.rd-en-gloss-mode').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    panel.appendChild(row);
  }
  return row;
}
function syncControl() {
  const row = ensureControl();
  const view = document.getElementById('reader-reading-view');
  if (!view) return;
  const isEn = currentLang() === 'en';
  if (row) {
    row.style.display = isEn ? 'flex' : 'none';
    row.querySelectorAll('.rd-en-gloss-mode').forEach(button => {
      button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
    });
  }
  view.classList.toggle('rd-en-unknown-gloss', isEn && enabled());
}
function setMode(next) {
  try { localStorage.setItem(MODE_KEY, next === 'off' ? 'off' : 'unknown'); } catch {}
  syncControl();
  scheduleScan(0);
}

function cachesSnapshot() {
  return {
    lemmas: lemmaCache(),
    legacy: legacyCache(),
    lexical: lexicalCache(),
    instant: instantWordCache(),
  };
}

function prepareStableSlots(root = document.getElementById('reader-chapter-text')) {
  injectStyles();
  syncControl();
  if (!enabled() || currentLang() !== 'en' || !root) return 0;
  const caches = cachesSnapshot();
  let count = 0;
  for (const el of root.querySelectorAll('.reader-word[data-word]')) {
    if (!isEnglishWord(el)) continue;
    const word = String(el.dataset.word || el.textContent || '').trim();
    const lemma = lemmaFor(word);
    const ru = bestHint(word, paragraphContext(el), lemma, caches);
    const wrap = ensureWrapper(el, ru);
    if (!wrap) continue;
    if (ru && knowledge(el) === 'unknown') wrap.dataset.enGlossVisible = '1';
    count++;
  }
  return count;
}

function isVisibleWord(el) {
  try {
    const r = el.getBoundingClientRect();
    const h = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    return r.width > 0 && r.height > 0 && r.bottom >= -80 && r.top <= h + 80;
  } catch { return true; }
}
function priorityScopes(root) {
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  if (!pages.length) return [{ root, visibleOnly:true }];
  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  if (current < 0) current = 0;
  return pages.slice(current, current + PREFETCH_PAGES + 1).map(page => ({ root:page, visibleOnly:false }));
}

async function translateMissing(tokens) {
  if (batchInFlight || !tokens.length || Date.now() < retryAfter) return;
  batchInFlight = true;
  try {
    await nativeTranslate(tokens.slice(0, MAX_BATCH));
    retryAfter = 0;
  } catch (error) {
    retryAfter = Date.now() + RETRY_AFTER_MS;
    console.warn('[en unknown gloss v4] offline translation failed:', error?.message || error);
  } finally {
    batchInFlight = false;
    scheduleScan(20);
  }
}

function scan() {
  syncControl();
  if (!enabled() || currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  prepareStableSlots(root);

  const caches = cachesSnapshot();
  const missing = [];
  const seen = new Set();
  for (const scope of priorityScopes(root)) {
    for (const el of scope.root.querySelectorAll('.reader-word[data-word]')) {
      if (!isEnglishWord(el)) continue;
      const state = knowledge(el);
      if (state !== 'unknown') continue;
      if (scope.visibleOnly && !isVisibleWord(el)) continue;
      const word = String(el.dataset.word || el.textContent || '').trim();
      const lemma = lemmaFor(word);
      const ru = bestHint(word, paragraphContext(el), lemma, caches);
      const wrap = ensureWrapper(el, ru);
      if (ru) {
        if (wrap) wrap.dataset.enGlossVisible = '1';
        continue;
      }
      const token = normalizeSurface(lemma || word);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      missing.push(token);
      if (missing.length >= MAX_BATCH) break;
    }
    if (missing.length >= MAX_BATCH) break;
  }
  if (missing.length) void translateMissing(missing);
}

function scheduleScan(delay = 40) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, Math.max(0, Number(delay) || 0));
}
function scanNow() { scheduleScan(0); }

function bindObservers() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== rootObserved) {
    rootObserver?.disconnect();
    rootObserved = root;
    rootObserver = new MutationObserver(() => scheduleScan(55));
    rootObserver.observe(root, {
      childList:true,
      subtree:true,
      attributes:true,
      attributeFilter:['class','data-lang','data-word'],
    });
  }
  const view = document.getElementById('reader-reading-view');
  if (view && view !== viewObserved) {
    viewObserver?.disconnect();
    viewObserved = view;
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(40); });
    viewObserver.observe(view, { attributes:true, attributeFilter:['data-reader-lang','class'] });
  }
}

function boot() {
  injectStyles();
  ensureControl();
  syncControl();
  bindObservers();
  scheduleScan(0);
}

const shouldInstall = typeof window !== 'undefined' && !window.__readerEnUnknownGlossV4Installed;
if (shouldInstall) {
  window.__readerEnUnknownGlossV4Installed = true;
  window.readerSetEnUnknownGlossMode = setMode;
  window.readerGetEnUnknownGlossMode = mode;
  window.readerPrepareEnStableSlots = prepareStableSlots;
  window.readerPrefetchEnUnknownGloss = scanNow;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
  window.addEventListener('pageshow', () => { boot(); scheduleScan(30); });
  window.addEventListener('reader:en-vocab-ready', () => scheduleScan(0));
  window.addEventListener('an2:languagechange', () => scheduleScan(0));
}

export { mode, enabled, compactRussian, legacyCacheKey as cacheKey, prepareStableSlots };

import { normalizeImportKey } from '../utils.js';

// English Unknown glosses v7.
// Chinese rendering stays untouched. English Unknown words get a real DOM
// child below the word. v7 makes the bundled WikDict the only source for the
// immediate inline gloss; deprecated Instant/lexical/legacy caches must never
// override it. Context refinement remains a separate later layer.
const MODE_KEY = 'an2_reader_en_unknown_gloss_mode_v2';
const CACHE_BASE_KEY = 'an2_reader_en_unknown_gloss_lemma_cache_v3';
const DEPRECATED_CACHE_KEYS = [
  'an2_instant_translate_word_cache_v1',
  'an2_reader_en_unknown_gloss_lemma_cache_v2',
  'an2_reader_en_unknown_gloss_cache_v1',
];
const MAX_CACHE = 8000;
const MAX_BATCH = 48;
const PREFETCH_PAGES = 2;
const DICT_URL = new URL('../../../wikdict/en_ru_core.json?v=1', import.meta.url).href;

let scanTimer = null;
let rootObserver = null;
let rootObserved = null;
let viewObserver = null;
let viewObserved = null;
let dictionaryPromise = null;
let dictionary = null;
let lookupInFlight = false;
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
function normalizedKey(word) { return normalizeImportKey(normalizeSurface(word)); }
function containsCyrillic(value) { return /[\u0400-\u052f]/.test(String(value || '')); }

function compactRussian(value) {
  const full = String(value || '').replace(/\s+/g, ' ').trim();
  if (!full || !containsCyrillic(full)) return '';
  const first = full.split(/\s*\|\s*|\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || full;
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
  const a = Math.max(2, Array.from(String(surface || '')).length);
  const b = Math.max(1, Array.from(String(ru || '')).length);
  const ratio = b / a;
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
  const clean = String(context || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${normalizedKey(word)}|${textHash(clean)}`;
}

function ownCache() { return readJson(scopedKey(CACHE_BASE_KEY)); }
function saveOwnCache(cache) {
  let entries = Object.entries(cache || {});
  if (entries.length > MAX_CACHE) {
    entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
    entries = entries.slice(0, MAX_CACHE);
  }
  writeJson(scopedKey(CACHE_BASE_KEY), Object.fromEntries(entries));
}
function purgeDeprecatedGlossCaches() {
  try {
    for (const key of DEPRECATED_CACHE_KEYS) {
      localStorage.removeItem(key);
      localStorage.removeItem(scopedKey(key));
    }
  } catch {}
}

function russianMeaning(data) {
  if (typeof data === 'string') return data.trim();
  const value = data && typeof data === 'object' ? data : {};
  return String(value.ru || value.translation_ru || value.russian || value.meaning_ru || value.meaning || '').trim();
}

function lemmaFor(word) {
  try { return normalizeSurface(globalThis.readerEnglishLemmaFor?.(word) || word); }
  catch { return normalizeSurface(word); }
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

function bestHint(word, context, lemma, caches = {}) {
  const own = caches.own || {};
  const direct = own[normalizedKey(lemma)] || own[normalizedKey(word)] || null;
  return compactRussian(russianMeaning(direct));
}

function isEnglishWord(el) {
  if (!el?.classList?.contains('reader-word')) return false;
  return /[A-Za-z]/.test(String(el.dataset?.word || el.textContent || ''));
}
function knowledge(el) {
  if (el?.classList?.contains('rw-migaku-unknown')) return 'unknown';
  if (el?.classList?.contains('rw-migaku-known')) return 'known';
  return '';
}

function wrapperFor(el) {
  return el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
}
function glossNode(wrap) {
  let node = wrap?.querySelector?.(':scope > .rw-en-gloss-text');
  if (!node && wrap) {
    node = document.createElement('span');
    node.className = 'rw-en-gloss-text';
    node.setAttribute('aria-hidden', 'true');
    wrap.appendChild(node);
  }
  return node;
}
function syncVisibility(el, wrap) {
  const state = knowledge(el);
  if (state === 'unknown') wrap.dataset.enGlossVisible = '1';
  else if (state === 'known') wrap.dataset.enGlossVisible = '0';
  return state;
}
function setWrapperTranslation(wrap, word, value) {
  const ru = compactRussian(value);
  const node = glossNode(wrap);
  if (!node) return '';
  if (!ru) return String(node.textContent || '').trim();
  node.textContent = ru;
  wrap.dataset.enGlossRu = ru;
  wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
  return ru;
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
  glossNode(wrap);
  if (ru) setWrapperTranslation(wrap, word, ru);
  syncVisibility(el, wrap);
  return wrap;
}

function rememberTranslation(sourceWord, ru, provider = 'wikdict_en_ru_offline') {
  const translation = compactRussian(ru);
  const key = normalizedKey(sourceWord);
  if (!key || !translation) return false;
  const cache = ownCache();
  cache[key] = { ru: translation, t: Date.now(), provider };
  saveOwnCache(cache);
  return true;
}

function applyTranslationToDom(sourceWord, ru, aliases = []) {
  const translation = compactRussian(ru);
  const sourceKeys = new Set([sourceWord, ...aliases].map(normalizedKey).filter(Boolean));
  const root = document.getElementById('reader-chapter-text');
  if (!translation || !sourceKeys.size || !root || currentLang() !== 'en') return 0;
  let count = 0;
  for (const el of root.querySelectorAll('.reader-word[data-word]')) {
    if (!isEnglishWord(el) || knowledge(el) === 'known') continue;
    const surface = String(el.dataset.word || el.textContent || '').trim();
    const lemma = lemmaFor(surface);
    if (!sourceKeys.has(normalizedKey(surface)) && !sourceKeys.has(normalizedKey(lemma))) continue;
    const wrap = ensureWrapper(el, translation);
    if (!wrap) continue;
    setWrapperTranslation(wrap, surface, translation);
    if (knowledge(el) === 'unknown') wrap.dataset.enGlossVisible = '1';
    count++;
  }
  return count;
}

async function loadDictionary() {
  if (dictionary) return dictionary;
  if (dictionaryPromise) return dictionaryPromise;
  dictionaryPromise = fetch(DICT_URL, { cache:'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`EN→RU dictionary HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('EN→RU dictionary payload is invalid');
      }
      dictionary = data;
      return data;
    })
    .finally(() => { dictionaryPromise = null; });
  return dictionaryPromise;
}

async function dictionaryLookup(words) {
  const dict = await loadDictionary();
  const out = {};
  for (const sourceWord of [...new Set((words || []).map(normalizeSurface).filter(Boolean))].slice(0, MAX_BATCH)) {
    const ru = compactRussian(dict[sourceWord] || '');
    if (!ru) continue;
    out[sourceWord] = ru;
    rememberTranslation(sourceWord, ru);
    applyTranslationToDom(sourceWord, ru);
  }
  return out;
}

function injectStyles() {
  document.getElementById('rd-en-unknown-gloss-style-v2')?.remove();
  document.getElementById('rd-en-unknown-gloss-style-v4')?.remove();
  if (document.getElementById('rd-en-unknown-gloss-style-v5')) return;
  const style = document.createElement('style');
  style.id = 'rd-en-unknown-gloss-style-v5';
  style.textContent = `
    #reader-reading-view.rd-en-unknown-gloss .reader-paragraph-text{line-height:1.86!important}
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap{
      display:inline-block!important;vertical-align:-.36em!important;line-height:1!important;
      margin:0 .025em!important;padding:0 0 .56em!important;position:relative!important;
      overflow:visible!important;white-space:nowrap!important
    }
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap>.reader-word{
      display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;
      white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important
    }
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-text{
      display:none;position:absolute!important;left:50%!important;bottom:0!important;
      transform:translateX(-50%)!important;max-width:none!important;white-space:nowrap!important;
      pointer-events:none!important;font-family:'IBM Plex Sans',sans-serif!important;
      font-size:var(--en-gloss-font,.38em)!important;font-weight:400!important;line-height:1!important;
      color:var(--text-muted)!important;text-decoration:none!important
    }
    #reader-reading-view.rd-en-unknown-gloss .rw-en-gloss-wrap[data-en-gloss-visible="1"]>.rw-en-gloss-text:not(:empty){
      display:block!important
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
  return { own:ownCache() };
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

async function lookupMissing(tokens) {
  if (lookupInFlight || !tokens.length) return;
  lookupInFlight = true;
  try {
    await dictionaryLookup(tokens.slice(0, MAX_BATCH));
  } catch (error) {
    console.warn('[en unknown gloss v7] bundled dictionary lookup failed:', error?.message || error);
  } finally {
    lookupInFlight = false;
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
      if (!isEnglishWord(el) || knowledge(el) !== 'unknown') continue;
      if (scope.visibleOnly && !isVisibleWord(el)) continue;
      const word = String(el.dataset.word || el.textContent || '').trim();
      const lemma = lemmaFor(word);
      const ru = bestHint(word, paragraphContext(el), lemma, caches);
      const wrap = ensureWrapper(el, ru);
      if (ru) {
        if (wrap) wrap.dataset.enGlossVisible = '1';
        continue;
      }
      const lemmaToken = normalizeSurface(lemma || word);
      const surfaceToken = normalizeSurface(word);
      for (const token of [lemmaToken, surfaceToken]) {
        if (!token || seen.has(token)) continue;
        seen.add(token);
        missing.push(token);
        if (missing.length >= MAX_BATCH) break;
      }
      if (missing.length >= MAX_BATCH) break;
    }
    if (missing.length >= MAX_BATCH) break;
  }
  if (missing.length) void lookupMissing(missing);
}

function scheduleScan(delay = 35) {
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
    rootObserver = new MutationObserver(() => scheduleScan(45));
    rootObserver.observe(root, {
      childList:true, subtree:true, attributes:true,
      attributeFilter:['class','data-lang','data-word'],
    });
  }
  const view = document.getElementById('reader-reading-view');
  if (view && view !== viewObserved) {
    viewObserver?.disconnect();
    viewObserved = view;
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(35); });
    viewObserver.observe(view, { attributes:true, attributeFilter:['data-reader-lang','class'] });
  }
}

function boot() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  purgeDeprecatedGlossCaches();
  injectStyles();
  ensureControl();
  syncControl();
  bindObservers();
  scheduleScan(0);
}

const shouldInstall = typeof window !== 'undefined' && !window.__readerEnUnknownGlossV7Installed;
if (shouldInstall) {
  window.__readerEnUnknownGlossV7Installed = true;
  window.readerSetEnUnknownGlossMode = setMode;
  window.readerGetEnUnknownGlossMode = mode;
  window.readerPrepareEnStableSlots = prepareStableSlots;
  window.readerPrefetchEnUnknownGloss = scanNow;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
  window.addEventListener('pageshow', () => { boot(); scheduleScan(25); });
  window.addEventListener('reader:en-vocab-ready', () => scheduleScan(0));
  window.addEventListener('an2:languagechange', () => scheduleScan(0));
}

export { mode, enabled, compactRussian, legacyCacheKey as cacheKey, prepareStableSlots };

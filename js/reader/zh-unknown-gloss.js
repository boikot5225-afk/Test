import { normalizeImportKey } from '../utils.js';

// Optional Chinese reading aid. This module deliberately stays outside the
// reader core. OFF (the default) means toc27 markup/behaviour is untouched.
const MODE_KEY = 'an2_reader_zh_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_zh_unknown_gloss_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.31';
const MAX_CACHE = 1200;
const MAX_CONCURRENT = 2;
const MAX_ENRICH_VISIBLE = 12;
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

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
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

function cacheKey(word, context) {
  return `${normalizeImportKey(word)}|${textHash(String(context || '').replace(/\s+/g, ' ').trim().slice(0, 220))}`;
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

function existingLexical(word, cache = null) {
  const source = cache || readJson(scopedKey('an2_reader_lexical_cache_v1'));
  return source[`zh:${normalizeImportKey(word)}`] || null;
}

function russianMeaning(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.ru || value.translation_ru || value.russian || value.meaning_ru || '').trim();
}

function pinyinReading(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.pinyin || value.py || value.pinyin_marked || value.pinyinTone || value.pronunciation || '').trim();
}

function compactRussian(value) {
  const full = String(value || '').replace(/\s+/g, ' ').trim();
  if (!full) return '';
  const parts = full.split(/\s*[;；]\s*/).filter(Boolean);
  const picked = parts.slice(0, 2).join(' · ');
  return picked.length > 22 ? picked.slice(0, 21).trimEnd() + '…' : picked;
}

function isChineseWordElement(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'zh'
    && /[㐀-鿿]/.test(String(el.dataset?.word || ''));
}

function isKnownElement(el) {
  return !!el?.classList?.contains('rw-known');
}

function wrapperFor(el) {
  const parent = el?.parentElement;
  return parent?.classList?.contains('rw-zh-gloss-wrap') ? parent : null;
}

function unwrapWord(el) {
  const wrap = wrapperFor(el);
  if (!wrap || !wrap.parentNode) return false;
  wrap.parentNode.insertBefore(el, wrap);
  wrap.remove();
  return true;
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

function bestCachedHint(word, context, existingPinyin = '', ownCache = null, lexicalCache = null) {
  const own = (ownCache || loadOwnCache())[cacheKey(word, context)] || null;
  const lexical = existingLexical(word, lexicalCache) || null;
  const ownRu = russianMeaning(own);
  const lexicalRu = russianMeaning(lexical);
  return {
    pinyin: pinyinReading(own) || pinyinReading(lexical) || existingPinyin || '',
    ru: ownRu || lexicalRu || '',
    fullRu: ownRu || lexicalRu || '',
  };
}

function ensureWrapper(el, hint = {}) {
  if (!isChineseWordElement(el)) return null;
  const word = String(el.dataset.word || '').trim();
  if (!word) return null;

  let wrap = wrapperFor(el);
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-zh-gloss-wrap';
    wrap.dataset.zhGloss = '1';
    el.parentNode?.insertBefore(wrap, el);
    wrap.appendChild(el);
  }

  const existingRt = String(el.querySelector?.('rt')?.textContent || '').trim();
  const pinyin = hint.pinyin || existingRt || '';
  const ru = compactRussian(hint.fullRu || hint.ru || '');
  wrap.dataset.zhGlossPinyin = pinyin || '';
  wrap.dataset.zhGlossRu = ru || '';
  return wrap;
}

function updateVisibleWord(word, context, data = {}) {
  if (!enabled()) return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const expectedKey = cacheKey(word, context);
  root.querySelectorAll('.reader-word[data-lang="zh"]').forEach((el) => {
    if (String(el.dataset.word || '') !== word) return;
    if (cacheKey(word, getParagraphContext(el)) !== expectedKey) return;
    const wrap = wrapperFor(el);
    if (!wrap) return;
    const pinyin = pinyinReading(data);
    const ru = compactRussian(russianMeaning(data));
    if (pinyin) wrap.dataset.zhGlossPinyin = pinyin;
    if (ru) wrap.dataset.zhGlossRu = ru;
  });
}

async function callReaderWord(word, context, fallbackPinyin = '') {
  // Use toc27's already-tested readerAI/Firebase/auth path. No second auth stack.
  const app = await canonicalApp();
  if (typeof app?.readerAI !== 'function') throw new Error('readerAI unavailable');
  const raw = await app.readerAI({
    task: 'reader_word',
    sourceLang: 'zh',
    word,
    surface: word,
    context,
  });
  return {
    pinyin: pinyinReading(raw) || fallbackPinyin || '',
    ru: russianMeaning(raw),
  };
}

function enqueueEnrichment(word, context, fallbackPinyin = '', lexicalEntry = null) {
  if (!enabled() || !word || !context) return;
  const key = cacheKey(word, context);
  const own = loadOwnCache()[key];
  if (own && russianMeaning(own)) return;
  if (russianMeaning(lexicalEntry || existingLexical(word))) return;
  if (queuedKeys.has(key)) return;
  const failed = Number(failedAt.get(key) || 0);
  if (failed && Date.now() - failed < RETRY_AFTER_MS) return;
  queuedKeys.add(key);
  queue.push({ key, word, context, fallbackPinyin });
  pumpQueue();
}

function pumpQueue() {
  while (enabled() && activeWorkers < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!job) break;
    activeWorkers++;
    (async () => {
      try {
        const data = await callReaderWord(job.word, job.context, job.fallbackPinyin);
        if (russianMeaning(data) || pinyinReading(data)) {
          const cache = loadOwnCache();
          cache[job.key] = { ...data, t: Date.now() };
          saveOwnCache(cache);
          updateVisibleWord(job.word, job.context, data);
        }
      } catch (error) {
        failedAt.set(job.key, Date.now());
        console.warn('[zh unknown gloss] enrichment failed:', job.word, error?.message || error);
      } finally {
        queuedKeys.delete(job.key);
        activeWorkers--;
        pumpQueue();
      }
    })();
  }
}

function isVisibleWord(el) {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const top = 0;
    const bottom = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    return rect.bottom >= top && rect.top <= bottom;
  } catch {
    return true;
  }
}

function injectStyles() {
  if (document.getElementById('rd-zh-unknown-gloss-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-zh-unknown-gloss-style';
  style.textContent = `
    /* Reserve one compact annotation lane above and below every text line.
       The inline-grid itself stays within this height, so pagination does not
       grow again after the word wrappers are installed. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.34 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-known rt {
      display: none !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: inline-grid;
      grid-template-rows: .56em 1.02em .50em;
      grid-template-columns: auto;
      align-items: center;
      justify-items: center;
      vertical-align: -.50em;
      line-height: 1 !important;
      margin: 0 .025em;
      padding: 0;
      position: relative;
      overflow: visible;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap > .reader-word {
      grid-row: 2;
      grid-column: 1;
      align-self: center;
      justify-self: center;
      display: inline !important;
      margin: 0 !important;
      padding: 0 1px !important;
      line-height: 1.02 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap > .reader-word rt {
      display: none !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      grid-column: 1;
      justify-self: center;
      width: 0;
      min-width: 0;
      overflow: visible;
      white-space: nowrap;
      text-align: center;
      pointer-events: none;
      font-family: 'IBM Plex Sans', sans-serif;
      font-weight: 500;
      color: var(--text-muted);
      line-height: 1;
      z-index: 1;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before {
      content: attr(data-zh-gloss-pinyin);
      grid-row: 1;
      align-self: end;
      font-size: .48em;
      color: color-mix(in srgb, var(--text-muted) 86%, var(--accent));
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: attr(data-zh-gloss-ru);
      grid-row: 3;
      align-self: start;
      font-size: .43em;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::after {
      color: var(--bad);
    }
  `;
  document.head.appendChild(style);
}

function ensureControl() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return null;
  let row = document.getElementById('rd-dp-zh-unknown-gloss-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'rd-dp-zh-unknown-gloss-row';
    row.className = 'rd-dp-row';
    row.style.display = 'none';
    row.innerHTML = `
      <span class="rd-dp-label">Китайский · незнакомые слова</span>
      <div class="rd-dp-pills">
        <button type="button" class="rd-dp-pill rd-zh-gloss-mode" data-mode="off">Обычный текст</button>
        <button type="button" class="rd-dp-pill rd-zh-gloss-mode" data-mode="unknown">Пиньинь + перевод</button>
      </div>`;
    row.querySelectorAll('.rd-zh-gloss-mode').forEach((button) => {
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
  const isZh = view.dataset.readerLang === 'zh';
  row.style.display = isZh ? 'flex' : 'none';
  row.querySelectorAll('.rd-zh-gloss-mode').forEach((button) => {
    button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
  });
  view.classList.toggle('rd-zh-unknown-gloss', enabled());
}

async function setMode(next) {
  const value = next === 'unknown' ? 'unknown' : 'off';
  try { localStorage.setItem(MODE_KEY, value); } catch {}
  syncControl();

  // Explicit mode changes may rebuild the chapter. OFF therefore restores the
  // exact stable toc27 markup; ON lets page mode measure the reserved line-height.
  try {
    const app = await canonicalApp();
    app.renderReaderChapter?.();
  } catch (error) {
    console.warn('[zh unknown gloss] reader refresh skipped:', error?.message || error);
  }
  scheduleScan(60);
}

function scheduleScan(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

function scan() {
  syncControl();
  if (!enabled()) return;
  const view = document.getElementById('reader-reading-view');
  const root = document.getElementById('reader-chapter-text');
  if (!view || !root || view.dataset.readerLang !== 'zh') return;

  root.querySelectorAll('.reader-paragraph').forEach((paragraph) => {
    if (!paragraphSourceText.has(paragraph)) {
      const source = String(paragraph.querySelector('.reader-paragraph-text')?.textContent || paragraph.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      paragraphSourceText.set(paragraph, source);
    }
  });

  const ownCache = loadOwnCache();
  const lexicalCache = readJson(scopedKey('an2_reader_lexical_cache_v1'));
  let queuedVisible = 0;
  const words = Array.from(root.querySelectorAll('.reader-word[data-lang="zh"]'));

  for (const el of words) {
    if (!isChineseWordElement(el)) continue;
    const word = String(el.dataset.word || '').trim();
    const context = getParagraphContext(el);
    const existingRt = String(el.querySelector('rt')?.textContent || '').trim();
    const lexicalEntry = existingLexical(word, lexicalCache);
    const hint = bestCachedHint(word, context, existingRt, ownCache, lexicalCache);
    const wrap = ensureWrapper(el, hint);
    if (!wrap) continue;

    if (hint.pinyin) wrap.dataset.zhGlossPinyin = hint.pinyin;
    if (hint.ru) wrap.dataset.zhGlossRu = compactRussian(hint.fullRu || hint.ru);

    if (!hint.ru && queuedVisible < MAX_ENRICH_VISIBLE && isVisibleWord(el)) {
      queuedVisible++;
      enqueueEnrichment(word, context, hint.pinyin || existingRt, lexicalEntry);
    }
  }
}

function installObservers() {
  injectStyles();
  ensureControl();
  syncControl();

  const root = document.getElementById('reader-chapter-text');
  if (root && !rootObserver) {
    rootObserver = new MutationObserver(() => scheduleScan(30));
    rootObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  const view = document.getElementById('reader-reading-view');
  if (view && !viewObserver) {
    viewObserver = new MutationObserver(() => {
      syncControl();
      scheduleScan(30);
    });
    viewObserver.observe(view, { attributes: true, attributeFilter: ['data-reader-lang', 'style'] });
  }

  scheduleScan(0);
}

if (typeof window !== 'undefined') {
  window.readerSetZhUnknownGlossMode = setMode;
  window.readerGetZhUnknownGlossMode = mode;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installObservers, { once: true });
  } else {
    installObservers();
  }
  window.addEventListener('pageshow', () => {
    installObservers();
    scheduleScan(60);
  });
}

export { mode, enabled, compactRussian, isKnownElement, cacheKey };
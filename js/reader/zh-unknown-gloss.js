import { normalizeImportKey } from '../utils.js';

// Optional Chinese reading aid. This module deliberately sits OUTSIDE the
// reader core: when disabled (the default), it does not alter rendered text,
// navigation, pagination, TTS, translations or word state.
const MODE_KEY = 'an2_reader_zh_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_zh_unknown_gloss_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.31';
const MAX_CACHE = 1200;
const MAX_CONCURRENT = 2;
const MAX_ENRICH_PER_ACTIVE_PARAGRAPH = 12;
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
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
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
    const keep = Object.fromEntries(entries.slice(0, MAX_CACHE));
    writeJson(scopedKey(CACHE_BASE_KEY), keep);
    return keep;
  }
  writeJson(scopedKey(CACHE_BASE_KEY), cache || {});
  return cache;
}

function existingLexical(word, cache = null) {
  const source = cache || readJson(scopedKey('an2_reader_lexical_cache_v1'));
  return source[`zh:${normalizeImportKey(word)}`] || null;
}

function russianMeaning(data = {}) {
  return String(data.ru || data.translation_ru || data.russian || data.meaning_ru || data.translation || data.meaning || '').trim();
}

function pinyinReading(data = {}) {
  return String(data.pinyin || data.py || data.pinyin_marked || data.pinyinTone || data.pronunciation || '').trim();
}

function compactRussian(value) {
  const full = String(value || '').replace(/\s+/g, ' ').trim();
  if (!full) return '';
  const parts = full.split(/\s*[;；]\s*/).filter(Boolean);
  const picked = parts.slice(0, 2).join(' · ');
  return picked.length > 28 ? picked.slice(0, 27).trimEnd() + '…' : picked;
}

function isChineseWordElement(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'zh'
    && /[㐀-鿿]/.test(String(el.dataset?.word || ''));
}

function isKnownElement(el) {
  return !!el?.classList?.contains('rw-known');
}

function clearAnnotation(el) {
  if (!el) return;
  el.classList?.remove('rw-zh-gloss');
  try {
    delete el.dataset.zhGloss;
    delete el.dataset.zhGlossPinyin;
    delete el.dataset.zhGlossRu;
  } catch {}
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
  return {
    pinyin: pinyinReading(own) || pinyinReading(lexical) || existingPinyin || '',
    ru: russianMeaning(own) || russianMeaning(lexical) || '',
    fullRu: russianMeaning(own) || russianMeaning(lexical) || '',
  };
}

function annotateWord(el, hint = {}) {
  if (!isChineseWordElement(el) || isKnownElement(el)) return false;
  const word = String(el.dataset.word || '').trim();
  if (!word) return false;

  const existingRt = String(el.querySelector?.('rt')?.textContent || '').trim();
  const pinyin = hint.pinyin || existingRt || '';
  const fullRu = hint.fullRu || hint.ru || '';
  const ru = compactRussian(fullRu);

  // Keep toc27's word/ruby DOM intact. The optional aid is only metadata + CSS
  // pseudo-elements, so word taps, selection and known-state classes keep using
  // the stable reader handlers.
  el.classList.add('rw-zh-gloss');
  el.dataset.zhGloss = '1';
  el.dataset.zhGlossPinyin = pinyin || '';
  el.dataset.zhGlossRu = ru || '…';
  return true;
}

function updateVisibleWord(word, context, data = {}) {
  if (!enabled()) return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const expectedKey = cacheKey(word, context);
  root.querySelectorAll('.reader-word.rw-zh-gloss[data-lang="zh"]').forEach((el) => {
    if (String(el.dataset.word || '') !== word) return;
    if (cacheKey(word, getParagraphContext(el)) !== expectedKey) return;
    const pinyin = pinyinReading(data);
    const fullRu = russianMeaning(data);
    if (pinyin) el.dataset.zhGlossPinyin = pinyin;
    if (fullRu) el.dataset.zhGlossRu = compactRussian(fullRu);
  });
}

async function callReaderWord(word, context, fallbackPinyin = '') {
  // Reuse the exact readerAI client from the stable reader core. Do not create
  // a second Firebase/callable/auth path here: toc27 already owns token refresh,
  // timeout handling and the callable response shape.
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

function injectStyles() {
  if (document.getElementById('rd-zh-unknown-gloss-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-zh-unknown-gloss-style';
  style.textContent = `
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.48 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss {
      position: relative;
      display: inline-block;
      vertical-align: baseline;
      padding: 0 .08em;
      margin: 0 .04em;
      border-radius: .24em;
      text-decoration: none;
      cursor: pointer;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss rt {
      display: none !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss::after {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      display: block;
      font-family: 'IBM Plex Sans', sans-serif;
      font-weight: 500;
      white-space: nowrap;
      pointer-events: none;
      text-align: center;
      max-width: 9.5em;
      overflow: hidden;
      text-overflow: ellipsis;
      z-index: 1;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss::before {
      content: attr(data-zh-gloss-pinyin);
      bottom: calc(100% - .02em);
      color: color-mix(in srgb, var(--text-muted) 86%, var(--accent));
      font-size: .5em;
      line-height: 1;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss::after {
      content: attr(data-zh-gloss-ru);
      top: calc(100% - .02em);
      color: var(--text-muted);
      font-size: .46em;
      line-height: 1.05;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss.rw-problem::after {
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

  try {
    const app = await canonicalApp();
    app.renderReaderChapter?.();
  } catch (error) {
    console.warn('[zh unknown gloss] reader refresh skipped:', error?.message || error);
  }
  scheduleScan(40);
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

  const active = root.querySelector('.reader-paragraph.active');
  const ownCache = loadOwnCache();
  const lexicalCache = readJson(scopedKey('an2_reader_lexical_cache_v1'));
  let queuedForActive = 0;
  root.querySelectorAll('.reader-word[data-lang="zh"]').forEach((el) => {
    if (!isChineseWordElement(el)) return;
    if (isKnownElement(el)) {
      clearAnnotation(el);
      return;
    }
    const word = String(el.dataset.word || '').trim();
    const context = getParagraphContext(el);
    const existingRt = String(el.querySelector('rt')?.textContent || '').trim();
    const lexicalEntry = existingLexical(word, lexicalCache);
    const hint = bestCachedHint(word, context, existingRt, ownCache, lexicalCache);

    if (el.dataset.zhGloss !== '1') annotateWord(el, hint);
    else {
      if (hint.pinyin && !String(el.dataset.zhGlossPinyin || '').trim()) {
        el.dataset.zhGlossPinyin = hint.pinyin;
      }
      if (hint.ru && String(el.dataset.zhGlossRu || '') === '…') {
        el.dataset.zhGlossRu = compactRussian(hint.fullRu || hint.ru);
      }
    }

    const paragraph = el.closest('.reader-paragraph');
    if (paragraph === active && !hint.ru && queuedForActive < MAX_ENRICH_PER_ACTIVE_PARAGRAPH) {
      queuedForActive++;
      enqueueEnrichment(word, context, hint.pinyin || existingRt, lexicalEntry);
    }
  });
}

function installObservers() {
  injectStyles();
  ensureControl();
  syncControl();

  const root = document.getElementById('reader-chapter-text');
  if (root && !rootObserver) {
    rootObserver = new MutationObserver(() => scheduleScan(20));
    rootObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  const view = document.getElementById('reader-reading-view');
  if (view && !viewObserver) {
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(20); });
    viewObserver.observe(view, { attributes: true, attributeFilter: ['data-reader-lang', 'style'] });
  }

  scheduleScan(0);
}

if (typeof window !== 'undefined') {
  window.readerSetZhUnknownGlossMode = setMode;
  window.readerGetZhUnknownGlossMode = mode;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installObservers, { once: true });
  else installObservers();
  window.addEventListener('pageshow', () => { installObservers(); scheduleScan(50); });
}

export { mode, enabled, compactRussian, isKnownElement, cacheKey };

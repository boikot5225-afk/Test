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
  // Inline glosses should stay tiny. Preserve at most the first two dictionary
  // senses and let the normal word card carry the full explanation.
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
  // The core renderer is the source of truth for user knowledge state.
  // rw-known is only assigned to explicitly learned Chinese words.
  return !!el?.classList?.contains('rw-known');
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

  el.classList.add('rw-zh-gloss');
  el.dataset.zhGloss = '1';
  el.innerHTML = '';

  const py = document.createElement('span');
  py.className = 'rw-zh-gloss-pinyin';
  py.textContent = pinyin || '\u00a0';
  el.appendChild(py);

  const hanzi = document.createElement('span');
  hanzi.className = 'rw-zh-gloss-hanzi';
  hanzi.textContent = word;
  el.appendChild(hanzi);

  const gloss = document.createElement('span');
  gloss.className = 'rw-zh-gloss-ru';
  gloss.textContent = ru || '…';
  if (fullRu) gloss.title = fullRu;
  el.appendChild(gloss);
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
    const py = el.querySelector('.rw-zh-gloss-pinyin');
    const ru = el.querySelector('.rw-zh-gloss-ru');
    const pinyin = pinyinReading(data);
    const fullRu = russianMeaning(data);
    if (py && pinyin) py.textContent = pinyin;
    if (ru && fullRu) {
      ru.textContent = compactRussian(fullRu);
      ru.title = fullRu;
    }
  });
}

async function callReaderWord(word, context, fallbackPinyin = '') {
  if (!globalThis.firebase?.app) throw new Error('Firebase unavailable');
  const region = String(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1').trim() || 'asia-southeast1';
  const callable = globalThis.firebase.app().functions(region).httpsCallable('readerAI');
  const result = await Promise.race([
    callable({
      task: 'reader_word',
      sourceLang: 'zh',
      word,
      surface: word,
      context,
      instruction: 'Return JSON only: {pinyin,ru}. pinyin: Mandarin pinyin with tone marks for this word in THIS context. ru: one short contextual Russian gloss, ideally 1-4 words. For a personal/place name, give a short Russian transliteration or label. No explanations.',
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('reader_word timeout')), 22000)),
  ]);
  const raw = result?.data?.data || result?.data || {};
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
    /* Optional Chinese unknown-word scaffold. Absolute annotations keep each
       token's measured width stable; the mode class reserves vertical room
       BEFORE page-mode measures the chapter. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 3.05 !important;
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
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-hanzi {
      display: inline-block;
      white-space: nowrap;
      line-height: 1.2;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-pinyin,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-ru {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      font-family: 'IBM Plex Sans', sans-serif;
      font-weight: 500;
      white-space: nowrap;
      pointer-events: none;
      text-align: center;
      max-width: 8.5em;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-pinyin {
      bottom: calc(100% + .08em);
      color: color-mix(in srgb, var(--text-muted) 86%, var(--accent));
      font-size: .56em;
      line-height: 1;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-ru {
      top: calc(100% + .08em);
      color: var(--text-muted);
      font-size: .5em;
      line-height: 1;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word.rw-zh-gloss.rw-problem .rw-zh-gloss-ru {
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

  // A core re-render is intentional ONLY on explicit mode changes. It restores
  // the exact stable reader markup when turning the feature off, and when
  // turning it on lets page mode measure the reserved annotation line-height
  // before this module decorates the words.
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

  // Freeze clean paragraph contexts before any annotation text is added.
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
    if (!isChineseWordElement(el) || isKnownElement(el)) return;
    const word = String(el.dataset.word || '').trim();
    const context = getParagraphContext(el);
    const existingRt = String(el.querySelector('rt')?.textContent || '').trim();
    const lexicalEntry = existingLexical(word, lexicalCache);
    const hint = bestCachedHint(word, context, existingRt, ownCache, lexicalCache);

    if (el.dataset.zhGloss !== '1') annotateWord(el, hint);
    else {
      const py = el.querySelector('.rw-zh-gloss-pinyin');
      const ru = el.querySelector('.rw-zh-gloss-ru');
      if (py && hint.pinyin && !String(py.textContent || '').trim()) py.textContent = hint.pinyin;
      if (ru && hint.ru && String(ru.textContent || '') === '…') {
        ru.textContent = compactRussian(hint.fullRu || hint.ru);
        ru.title = hint.fullRu || hint.ru;
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

import { normalizeImportKey } from '../utils.js';

// Chinese Unknown-word gloss v2.
//
// Mirrors the stable English-v2 architecture:
// - network work is driven only by CONFIRMED Unknown words;
// - the current page is never truncated by an arbitrary word-count cap;
// - four workers stay bounded, while every current-page Unknown is eventually
//   drained through the queue;
// - next two pages are prefetched opportunistically without starving the page
//   the user is actually reading;
// - transient request failures retry automatically instead of leaving a blank
//   word for five minutes;
// - already resolved pinyin/RU is never overwritten by an empty value.

const MODE_KEY = 'an2_reader_zh_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_zh_unknown_gloss_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.31';
const MAX_CACHE = 3200;
const MAX_CONCURRENT = 4;
const PREFETCH_PAGE_COUNT = 2;
const PREFETCH_HEAD_PER_PAGE = 8;
const MAX_OPTIONAL_QUEUE = 96;
const MAX_RETRY_MS = 60_000;

let appPromise = null;
let scanTimer = null;
let rootObserver = null;
let rootObserved = null;
let viewObserver = null;
let viewObserved = null;
let activeWorkers = 0;

const queue = [];
const queuedKeys = new Set();
const failureState = new Map();
const paragraphSourceText = new WeakMap();
const liveWrappersByKey = new Map();

const stats = {
  scans: 0,
  currentUnknownMissing: 0,
  prefetchUnknownMissing: 0,
  queued: 0,
  completed: 0,
  failed: 0,
  retried: 0,
  skippedKnown: 0,
  skippedPending: 0,
};

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function mode() {
  try { return localStorage.getItem(MODE_KEY) === 'unknown' ? 'unknown' : 'off'; }
  catch { return 'off'; }
}
function enabled() { return mode() === 'unknown'; }

function currentLang() {
  return String(document.getElementById('reader-reading-view')?.dataset?.readerLang || '').toLowerCase();
}

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

function ownCache() { return readJson(scopedKey(CACHE_BASE_KEY)); }
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
function existingLexical(word, cache = null) {
  const source = cache || lexicalCache();
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

function isChineseWord(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'zh'
    && /[㐀-鿿]/.test(String(el.dataset?.word || ''));
}

function knowledgeState(el) {
  if (!el) return '';
  if (el.classList.contains('rw-migaku-unknown')) return 'unknown';
  if (el.classList.contains('rw-migaku-known') || el.classList.contains('rw-known')) return 'known';
  return '';
}

function wrapperFor(el) {
  const parent = el?.parentElement;
  return parent?.classList?.contains('rw-zh-gloss-wrap') ? parent : null;
}

function ensureWrapper(el, hint = {}) {
  if (!isChineseWord(el)) return null;
  let wrap = wrapperFor(el);
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-zh-gloss-wrap rw-zh-fixed-slot';
    wrap.dataset.zhGloss = '1';
    const parent = el.parentNode;
    if (!parent) return null;
    parent.insertBefore(wrap, el);
    wrap.appendChild(el);
  } else {
    wrap.classList.add('rw-zh-fixed-slot');
  }

  const existingRt = String(el.querySelector?.('rt')?.textContent || '').trim();
  const pinyin = pinyinReading(hint) || String(hint.pinyin || '') || existingRt;
  const ru = compactRussian(russianMeaning(hint) || hint.fullRu || hint.ru || '');

  // Critical v2 rule: a blank pass is not new information. Never erase a
  // resolved value merely because another cache/classifier pass is pending.
  if (pinyin) wrap.dataset.zhGlossPinyin = pinyin;
  if (ru) wrap.dataset.zhGlossRu = ru;
  if (!('zhGlossRu' in wrap.dataset)) wrap.dataset.zhGlossRu = '';
  return wrap;
}

function paragraphContext(el) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return '';
  if (paragraphSourceText.has(paragraph)) return paragraphSourceText.get(paragraph) || '';
  const source = String(paragraph.querySelector?.('.reader-paragraph-text')?.textContent || paragraph.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  paragraphSourceText.set(paragraph, source);
  return source;
}

function bestHint(word, context, existingPinyin = '', own = null, lexical = null) {
  const ownHit = (own || ownCache())[cacheKey(word, context)] || null;
  const lexHit = existingLexical(word, lexical);
  const ru = russianMeaning(ownHit) || russianMeaning(lexHit) || '';
  return {
    pinyin: pinyinReading(ownHit) || pinyinReading(lexHit) || existingPinyin || '',
    ru,
    fullRu: ru,
  };
}

function registerWrapper(key, wrap) {
  if (!key || !wrap) return;
  let set = liveWrappersByKey.get(key);
  if (!set) {
    set = new Set();
    liveWrappersByKey.set(key, set);
  }
  set.add(wrap);
  wrap.dataset.zhGlossKey = key;
}

function updateLive(key, data = {}) {
  const wraps = liveWrappersByKey.get(key);
  if (!wraps?.size) return;
  const pinyin = pinyinReading(data);
  const ru = compactRussian(russianMeaning(data));
  for (const wrap of [...wraps]) {
    if (!wrap?.isConnected) {
      wraps.delete(wrap);
      continue;
    }
    if (pinyin) wrap.dataset.zhGlossPinyin = pinyin;
    if (ru) wrap.dataset.zhGlossRu = ru;
  }
  if (!wraps.size) liveWrappersByKey.delete(key);
  try { globalThis.readerSyncZhGlossStability?.(); } catch {}
}

async function callReaderWord(word, context, fallbackPinyin = '') {
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

function retryDelay(key) {
  const info = failureState.get(key);
  if (!info) return 0;
  return Math.min(MAX_RETRY_MS, 4_000 * Math.pow(2, Math.max(0, Number(info.attempts || 1) - 1)));
}
function retryReady(key) {
  const info = failureState.get(key);
  if (!info) return true;
  return Date.now() - Number(info.t || 0) >= retryDelay(key);
}
function markFailure(key) {
  const prev = failureState.get(key) || { attempts: 0, t: 0 };
  const next = { attempts: Number(prev.attempts || 0) + 1, t: Date.now() };
  failureState.set(key, next);
  stats.failed += 1;
  const wait = retryDelay(key);
  setTimeout(() => scheduleScan(0), wait + 25);
}
function clearFailure(key) { failureState.delete(key); }

function enqueue(job, priority = 1, requiredCurrent = false) {
  if (!enabled() || !job?.key || !job.word || !job.context) return false;
  if (queuedKeys.has(job.key)) return false;
  if (!retryReady(job.key)) return false;

  const own = ownCache()[job.key];
  if (russianMeaning(own)) return false;
  if (russianMeaning(job.lexical || existingLexical(job.word))) return false;

  // Optional prefetch must stay bounded. Current-page jobs are never dropped:
  // they are what the user can see and are allowed to exceed this queue cap.
  if (!requiredCurrent && queue.length >= MAX_OPTIONAL_QUEUE) return false;

  if (failureState.has(job.key)) stats.retried += 1;
  queuedKeys.add(job.key);
  const item = { ...job, priority, requiredCurrent };
  const at = queue.findIndex(existing => Number(existing.priority || 0) > priority);
  if (at === -1) queue.push(item);
  else queue.splice(at, 0, item);
  stats.queued += 1;
  pump();
  return true;
}

function pump() {
  while (enabled() && activeWorkers < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!job) break;
    activeWorkers += 1;
    (async () => {
      try {
        const data = await callReaderWord(job.word, job.context, job.fallbackPinyin);
        const ru = russianMeaning(data);
        const pinyin = pinyinReading(data);
        if (ru || pinyin) {
          const cache = ownCache();
          // Preserve previous non-empty fields if this response is partial.
          const prev = cache[job.key] || {};
          cache[job.key] = {
            ...prev,
            ...(pinyin ? { pinyin } : {}),
            ...(ru ? { ru } : {}),
            t: Date.now(),
          };
          saveOwnCache(cache);
          updateLive(job.key, cache[job.key]);
        }

        if (ru) {
          clearFailure(job.key);
          stats.completed += 1;
        } else {
          // Pinyin-only/empty responses are not "done": translation is still
          // missing, so retry with bounded backoff instead of leaving a hole.
          markFailure(job.key);
        }
      } catch (error) {
        markFailure(job.key);
        console.warn('[zh unknown gloss v2] enrichment failed:', job.word, error?.message || error);
      } finally {
        queuedKeys.delete(job.key);
        activeWorkers -= 1;
        pump();
        // This is the old "word #29" fix: each finished batch explicitly asks
        // for another pass so no current-page Unknown can be stranded by a cap.
        scheduleScan(15);
      }
    })();
  }
}

function isVisibleWord(el) {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const bottom = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    return rect.bottom >= 0 && rect.top <= bottom;
  } catch { return true; }
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
    row.querySelectorAll('.rd-zh-gloss-mode').forEach(button => {
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
  const isZh = currentLang() === 'zh';
  row.style.display = isZh ? 'flex' : 'none';
  row.querySelectorAll('.rd-zh-gloss-mode').forEach(button => {
    button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
  });
  view.classList.toggle('rd-zh-unknown-gloss', isZh && enabled());
}

async function setMode(next) {
  try { localStorage.setItem(MODE_KEY, next === 'unknown' ? 'unknown' : 'off'); } catch {}
  syncControl();
  try { (await canonicalApp()).renderReaderChapter?.(); }
  catch (error) { console.warn('[zh unknown gloss v2] refresh skipped:', error?.message || error); }
  scheduleScan(30);
}

function scheduleScan(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

function collectMissing(scope, own, lexical, requireVisible = false) {
  const result = [];
  const words = scope?.querySelectorAll?.('.reader-word[data-lang="zh"][data-word]') || [];
  for (const el of words) {
    if (!isChineseWord(el)) continue;
    const word = String(el.dataset.word || '').trim();
    const context = paragraphContext(el);
    const key = cacheKey(word, context);
    const existingRt = String(el.querySelector?.('rt')?.textContent || '').trim();
    const lexicalEntry = existingLexical(word, lexical);
    const hint = bestHint(word, context, existingRt, own, lexical);
    const wrap = ensureWrapper(el, hint);
    if (!wrap) continue;
    registerWrapper(key, wrap);

    if (hint.pinyin) wrap.dataset.zhGlossPinyin = hint.pinyin;
    if (hint.ru) wrap.dataset.zhGlossRu = compactRussian(hint.fullRu || hint.ru);

    const state = knowledgeState(el);
    if (state === 'known') {
      stats.skippedKnown += 1;
      continue;
    }
    if (state !== 'unknown') {
      stats.skippedPending += 1;
      continue;
    }
    if (hint.ru) continue;
    if (requireVisible && !isVisibleWord(el)) continue;

    result.push({
      key,
      word,
      context,
      fallbackPinyin: hint.pinyin || existingRt,
      lexical: lexicalEntry,
    });
  }
  return result;
}

function enqueueSlice(list, start, end, priority, requiredCurrent = false) {
  for (const job of list.slice(start, end)) enqueue(job, priority, requiredCurrent);
}

function scan() {
  stats.scans += 1;
  syncControl();
  if (!enabled() || currentLang() !== 'zh') return;
  bindObservers();
  pump();

  const root = document.getElementById('reader-chapter-text');
  if (!root) return;

  const own = ownCache();
  const lexical = lexicalCache();
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  if (current < 0) current = 0;

  if (!pages.length) {
    const visibleMissing = collectMissing(root, own, lexical, true);
    stats.currentUnknownMissing = visibleMissing.length;
    enqueueSlice(visibleMissing, 0, visibleMissing.length, 0, true);
    return;
  }

  const scopes = pages.slice(current, current + PREFETCH_PAGE_COUNT + 1);
  const missing = scopes.map(scope => collectMissing(scope, own, lexical, false));
  const here = missing[0] || [];
  stats.currentUnknownMissing = here.length;
  stats.prefetchUnknownMissing = missing.slice(1).reduce((sum, list) => sum + list.length, 0);

  // Four visible jobs first, then seed N+1/N+2, then drain every remaining
  // Unknown on the current page. There is intentionally NO current-page cap.
  const head = Math.min(MAX_CONCURRENT, here.length);
  enqueueSlice(here, 0, head, 0, true);

  for (let i = 1; i < missing.length; i++) {
    const list = missing[i] || [];
    enqueueSlice(list, 0, Math.min(PREFETCH_HEAD_PER_PAGE, list.length), i, false);
  }

  enqueueSlice(here, head, here.length, PREFETCH_PAGE_COUNT + 1, true);

  for (let i = 1; i < missing.length; i++) {
    const list = missing[i] || [];
    const start = Math.min(PREFETCH_HEAD_PER_PAGE, list.length);
    enqueueSlice(list, start, list.length, PREFETCH_PAGE_COUNT + 2 + i, false);
  }
}

function bindObservers() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== rootObserved) {
    rootObserver?.disconnect();
    rootObserved = root;
    rootObserver = new MutationObserver(records => {
      const relevant = records.some(record => {
        if (record.type === 'attributes') return true;
        return Array.from(record.addedNodes || []).some(node => node instanceof Element);
      });
      if (relevant) scheduleScan(20);
    });
    rootObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  const view = document.getElementById('reader-reading-view');
  if (view && view !== viewObserved) {
    viewObserver?.disconnect();
    viewObserved = view;
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(20); });
    viewObserver.observe(view, { attributes: true, attributeFilter: ['data-reader-lang', 'style', 'class'] });
  }
}

function boot() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  ensureControl();
  syncControl();
  bindObservers();
  scheduleScan(0);
}

if (typeof window !== 'undefined') {
  window.readerSetZhUnknownGlossMode = setMode;
  window.readerGetZhUnknownGlossMode = mode;
  window.readerPrefetchZhUnknownGloss = () => scheduleScan(0);
  window.readerZhUnknownGlossQueueStats = () => ({
    ...stats,
    activeWorkers,
    queueLength: queue.length,
    queuedKeys: queuedKeys.size,
    failedKeys: failureState.size,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', () => { boot(); scheduleScan(30); });
  window.addEventListener('reader:zh-core-ready', () => scheduleScan(10));
}

export { mode, enabled, compactRussian, cacheKey, knowledgeState };

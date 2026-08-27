import { normalizeImportKey } from '../utils.js';

// Chinese Unknown-word gloss v3.
//
// Fixes the remaining holes visible on-device:
// - the WHOLE current page outranks every prefetch job (v2 only prioritized its first 4 words);
// - bundled CC-CEDICT pinyin is read directly from readerLookupChineseWord(), so a word does not
//   wait for DeepSeek merely to learn its pronunciation;
// - reader_word context is built without <rt> ruby text, so already-rendered pinyin cannot pollute
//   later model requests in the same paragraph;
// - only confirmed Unknown words use network workers;
// - current-page Unknown is never dropped by a queue-size cap;
// - pinyin-only/empty responses retry with bounded backoff until Russian meaning arrives;
// - blank passes never erase already resolved annotations.

const MODE_KEY = 'an2_reader_zh_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_zh_unknown_gloss_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.31';
const MAX_CACHE = 3600;
const MAX_CONCURRENT = 4;
const PREFETCH_PAGE_COUNT = 2;
const PREFETCH_PER_PAGE = 12;
const MAX_OPTIONAL_QUEUE = 72;
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
  currentMissing: 0,
  prefetchMissing: 0,
  queuedCurrent: 0,
  queuedPrefetch: 0,
  completed: 0,
  failed: 0,
  localPinyinHits: 0,
  localRuHits: 0,
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

function normalizeContext(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 260);
}

function cacheKey(word, context) {
  return `${normalizeImportKey(word)}|${textHash(normalizeContext(context))}`;
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
function lexicalEntry(word, cache = null) {
  const source = cache || lexicalCache();
  return source[`zh:${normalizeImportKey(word)}`] || null;
}

function russianMeaning(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.ru || value.translation_ru || value.russian || value.meaning_ru || value.translation || '').trim();
}
function pinyinReading(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.pinyin || value.py || value.pinyin_marked || value.pinyinTone || value.pronunciation || value.form_note || '').trim();
}
function compactRussian(value) {
  const full = String(value || '').replace(/\s+/g, ' ').trim();
  if (!full) return '';
  const parts = full.split(/\s*[;；]\s*/).filter(Boolean);
  const picked = parts.slice(0, 2).join(' · ');
  return picked.length > 24 ? picked.slice(0, 23).trimEnd() + '…' : picked;
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
  if (pinyin) wrap.dataset.zhGlossPinyin = pinyin;
  if (ru) wrap.dataset.zhGlossRu = ru;
  if (!('zhGlossRu' in wrap.dataset)) wrap.dataset.zhGlossRu = '';
  return wrap;
}

function localDictionaryHint(word) {
  try {
    const hit = globalThis.readerLookupChineseWord?.(word) || null;
    if (hit) return hit;
  } catch {}
  return null;
}

function paragraphContext(el) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return String(el?.dataset?.word || '').trim();
  if (paragraphSourceText.has(paragraph)) return paragraphSourceText.get(paragraph) || '';

  let source = '';
  const textRoot = paragraph.querySelector?.('.reader-paragraph-text');
  if (textRoot) {
    try {
      const clone = textRoot.cloneNode(true);
      clone.querySelectorAll?.('rt').forEach(node => node.remove());
      source = String(clone.textContent || '');
    } catch {
      source = String(textRoot.textContent || '');
    }
  } else {
    source = String(paragraph.textContent || '');
  }
  source = normalizeContext(source);
  if (!source) source = String(el?.dataset?.word || '').trim();
  paragraphSourceText.set(paragraph, source);
  return source;
}

function bestHint(word, context, existingPinyin = '', own = null, lexical = null) {
  const ownHit = (own || ownCache())[cacheKey(word, context)] || null;
  const lexHit = lexicalEntry(word, lexical);
  const localHit = localDictionaryHint(word);
  const pinyin = pinyinReading(ownHit) || pinyinReading(lexHit) || pinyinReading(localHit) || existingPinyin || '';
  const ru = russianMeaning(ownHit) || russianMeaning(lexHit) || russianMeaning(localHit) || '';
  if (!pinyinReading(ownHit) && !pinyinReading(lexHit) && pinyinReading(localHit)) stats.localPinyinHits += 1;
  if (!russianMeaning(ownHit) && !russianMeaning(lexHit) && russianMeaning(localHit)) stats.localRuHits += 1;
  return { pinyin, ru, fullRu: ru, local: localHit };
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

async function callReaderWord(word, context, fallbackPinyin = '', localHint = null) {
  const app = await canonicalApp();
  if (typeof app?.readerAI !== 'function') throw new Error('readerAI unavailable');
  const raw = await app.readerAI({
    task: 'reader_word',
    sourceLang: 'zh',
    word,
    surface: word,
    context: normalizeContext(context) || word,
    hint: localHint ? {
      lemma: localHint.lemma || localHint.word || word,
      pinyin: pinyinReading(localHint) || fallbackPinyin || '',
      en: localHint.en || localHint.english || '',
    } : undefined,
    instruction: 'Return JSON only: {pos, lemma, surface, pinyin, ru, level, form_note, note}. Give pinyin with tone marks and a short Russian meaning in ru. No gender.'
  });
  return {
    pinyin: pinyinReading(raw) || fallbackPinyin || pinyinReading(localHint) || '',
    ru: russianMeaning(raw),
  };
}

function retryDelay(key) {
  const info = failureState.get(key);
  if (!info) return 0;
  return Math.min(MAX_RETRY_MS, 3_000 * Math.pow(2, Math.max(0, Number(info.attempts || 1) - 1)));
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
  setTimeout(() => scheduleScan(0), retryDelay(key) + 30);
}
function clearFailure(key) { failureState.delete(key); }

function enqueue(job, priority = 0, requiredCurrent = false) {
  if (!enabled() || !job?.key || !job.word) return false;
  if (queuedKeys.has(job.key) || !retryReady(job.key)) return false;
  const own = ownCache()[job.key];
  if (russianMeaning(own)) return false;
  if (russianMeaning(job.lexical) || russianMeaning(job.local)) return false;
  if (!requiredCurrent && queue.length >= MAX_OPTIONAL_QUEUE) return false;

  queuedKeys.add(job.key);
  const item = { ...job, priority, requiredCurrent };
  const at = queue.findIndex(existing => Number(existing.priority || 0) > priority);
  if (at === -1) queue.push(item);
  else queue.splice(at, 0, item);
  if (requiredCurrent) stats.queuedCurrent += 1;
  else stats.queuedPrefetch += 1;
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
        const data = await callReaderWord(job.word, job.context, job.fallbackPinyin, job.local);
        const ru = russianMeaning(data);
        const pinyin = pinyinReading(data);
        if (ru || pinyin) {
          const cache = ownCache();
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
          markFailure(job.key);
        }
      } catch (error) {
        markFailure(job.key);
        console.warn('[zh unknown gloss v3] enrichment failed:', job.word, error?.message || error);
      } finally {
        queuedKeys.delete(job.key);
        activeWorkers -= 1;
        pump();
        scheduleScan(20);
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
  catch (error) { console.warn('[zh unknown gloss v3] refresh skipped:', error?.message || error); }
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
    if (requireVisible && !isVisibleWord(el)) continue;

    const word = String(el.dataset.word || '').trim();
    const context = paragraphContext(el) || word;
    const key = cacheKey(word, context);
    const existingRt = String(el.querySelector?.('rt')?.textContent || '').trim();
    const lex = lexicalEntry(word, lexical);
    const hint = bestHint(word, context, existingRt, own, lexical);
    const wrap = ensureWrapper(el, hint);
    if (!wrap) continue;
    registerWrapper(key, wrap);

    if (hint.pinyin) wrap.dataset.zhGlossPinyin = hint.pinyin;
    if (hint.ru) wrap.dataset.zhGlossRu = compactRussian(hint.ru);

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

    result.push({
      key,
      word,
      context,
      fallbackPinyin: hint.pinyin || existingRt,
      lexical: lex,
      local: hint.local,
    });
  }
  return result;
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
    const here = collectMissing(root, own, lexical, true);
    stats.currentMissing = here.length;
    // Enqueue ALL visible current-page jobs before there is any optional work.
    for (const job of here) enqueue(job, 0, true);
    return;
  }

  const currentScope = pages[current];
  const here = collectMissing(currentScope, own, lexical, false);
  stats.currentMissing = here.length;

  // Strict current-page-first rule. Calling enqueue() starts the first four immediately;
  // every remaining current job stays at priority 0 in the queue before prefetch is added.
  for (const job of here) enqueue(job, 0, true);

  let prefetchCount = 0;
  for (let offset = 1; offset <= PREFETCH_PAGE_COUNT; offset++) {
    const scope = pages[current + offset];
    if (!scope) break;
    const list = collectMissing(scope, own, lexical, false);
    prefetchCount += list.length;
    for (const job of list.slice(0, PREFETCH_PER_PAGE)) enqueue(job, 10 + offset, false);
  }
  stats.prefetchMissing = prefetchCount;
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
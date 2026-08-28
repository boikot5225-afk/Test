const STYLE_ID = 'reader-zh-readable-inline-v1';
const LEGACY_STYLE_IDS = [
  'reader-zh-stable-slots-v3',
  'reader-zh-unknown-interlinear-v1',
  'reader-zh-unknown-interlinear-v2',
  'rd-zh-unknown-gloss-spacing-style',
  'reader-zh-toc88-inline-style',
];
const APP_URL = '../reader-app.js?v=77.32';
const CACHE_BASE = 'an2_reader_zh_context_gloss_v3';
const MAX_CONCURRENT = 3;
const RETRY_MS = 20_000;

let appPromise = null;
let observer = null;
let observedRoot = null;
let scanTimer = null;
let workers = 0;
let cache = null;
let cacheKeyInUse = '';

const queue = [];
const queued = new Set();
const running = new Set();
const failures = new Map();
const paragraphTextCache = new WeakMap();

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasRussian(value) {
  return /[\u0400-\u052f]/.test(String(value || ''));
}

function enabled() {
  const view = document.getElementById('reader-reading-view');
  if (!view || String(view.dataset.readerLang || '').toLowerCase() !== 'zh') return false;
  try { return globalThis.readerGetZhUnknownGlossMode?.() === 'unknown'; }
  catch { return view.classList.contains('rd-zh-unknown-gloss'); }
}

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function textHash(text) {
  let h = 2166136261;
  for (const ch of String(text || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function contextKey(word, context) {
  return `${clean(word)}|${textHash(clean(context).slice(0, 360))}`;
}

function loadCache() {
  const key = scopedKey(CACHE_BASE);
  if (cache && cacheKeyInUse === key) return cache;
  cacheKeyInUse = key;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  if (!cache) return;
  const entries = Object.entries(cache);
  if (entries.length > 5000) {
    entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
    cache = Object.fromEntries(entries.slice(0, 5000));
  }
  try { localStorage.setItem(cacheKeyInUse || scopedKey(CACHE_BASE), JSON.stringify(cache)); }
  catch {}
}

function compactRussian(value) {
  let text = clean(value);
  if (!hasRussian(text)) return '';
  text = text
    .split(/\s*(?:[;；/|·•]|[.!?。！？]|[,，])\s*/)[0]
    .replace(/\s*[（(][^()（）]{1,80}[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > 3 ? words.slice(0, 3).join(' ') : text;
}

function wordState(word) {
  if (word?.classList?.contains('rw-migaku-unknown')) return 'unknown';
  if (word?.classList?.contains('rw-migaku-known') || word?.classList?.contains('rw-known')) return 'known';
  return '';
}

function paragraphContext(word) {
  const paragraph = word?.closest?.('.reader-paragraph');
  if (!paragraph) return clean(word?.dataset?.word || word?.textContent || '');
  if (paragraphTextCache.has(paragraph)) return paragraphTextCache.get(paragraph) || '';

  let source = '';
  try {
    const root = paragraph.querySelector('.reader-paragraph-text') || paragraph;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('rt,.rw-zh-readable-pinyin,.rw-zh-readable-ru').forEach(node => node.remove());
    source = clean(clone.textContent).slice(0, 360);
  } catch {
    source = clean(paragraph.textContent).slice(0, 360);
  }
  paragraphTextCache.set(paragraph, source);
  return source;
}

function ensureLane(wrap, className) {
  let lane = wrap.querySelector(`:scope > .${className}`);
  if (!lane) {
    lane = document.createElement('span');
    lane.className = className;
    lane.setAttribute('aria-hidden', 'true');
    wrap.appendChild(lane);
  }
  return lane;
}

function setLaneText(wrap, className, value) {
  const lane = ensureLane(wrap, className);
  const next = clean(value);
  if (clean(lane.textContent) !== next) lane.textContent = next;
  return lane;
}

function clearLanes(wrap) {
  wrap.querySelectorAll(':scope > .rw-zh-readable-pinyin,:scope > .rw-zh-readable-ru').forEach(node => node.remove());
}

function localPinyin(wrap, word) {
  return clean(
    wrap.dataset.zhGlossStickyPinyin
    || wrap.dataset.zhGlossPinyin
    || word.querySelector('rt')?.textContent
    || '',
  );
}

function localRussian(wrap) {
  const source = wrap.dataset.zhGlossStickyRu
    || wrap.dataset.zhGlossRuReadable
    || wrap.dataset.zhGlossRu
    || '';
  return compactRussian(source);
}

function manualRussian(wrap) {
  return wrap.dataset.zhGlossSource === 'instant' ? localRussian(wrap) : '';
}

function isVisible(word) {
  try {
    const rect = word.getBoundingClientRect();
    const height = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    const width = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
    return rect.width > 0 && rect.height > 0
      && rect.bottom >= -120 && rect.top <= height + 120
      && rect.right >= -80 && rect.left <= width + 80;
  } catch {
    return true;
  }
}

function app() {
  if (!appPromise) appPromise = import(APP_URL);
  return appPromise;
}

function normalizeResult(raw) {
  return {
    ru: compactRussian(raw?.ru || raw?.translation_ru || raw?.russian || raw?.meaning_ru || raw?.translation || ''),
    pinyin: clean(raw?.pinyin || raw?.py || raw?.pinyin_marked || raw?.pronunciation || ''),
  };
}

async function requestContextMeaning(word, context, pinyin) {
  const mod = await app();
  if (typeof mod?.readerAI !== 'function') throw new Error('readerAI unavailable');
  const raw = await mod.readerAI({
    task: 'reader_word',
    sourceLang: 'zh',
    word,
    surface: word,
    context: clean(context).slice(0, 360) || word,
    hint: { pinyin },
    instruction: 'Return JSON only. ru: exactly ONE short Russian translation for this word in this context, preferably 1-2 words and never more than 3 words. No English. No examples. No explanations. No sentence translation. pinyin: the correct contextual pinyin with tone marks.',
  });
  return normalizeResult(raw);
}

function enqueue(wrap, word, key, context, pinyin) {
  if (!enabled() || queued.has(key) || running.has(key) || !isVisible(word)) return;
  const lastFailure = Number(failures.get(key) || 0);
  if (lastFailure && Date.now() - lastFailure < RETRY_MS) return;

  queued.add(key);
  queue.push({ wrap, word, key, context, pinyin });
  pump();
}

function pump() {
  while (enabled() && workers < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!job) break;
    queued.delete(job.key);
    running.add(job.key);
    workers += 1;

    (async () => {
      try {
        const surface = clean(job.word.dataset.word || job.word.textContent || '');
        const result = await requestContextMeaning(surface, job.context, job.pinyin);
        if (!result.ru) throw new Error('empty Russian context meaning');
        loadCache()[job.key] = {
          ru: result.ru,
          ...(result.pinyin ? { pinyin: result.pinyin } : {}),
          t: Date.now(),
        };
        saveCache();
        failures.delete(job.key);
        syncKey(job.key);
      } catch (error) {
        failures.set(job.key, Date.now());
        if (job.wrap?.isConnected) {
          const fallback = localRussian(job.wrap);
          if (fallback) {
            job.wrap.dataset.zhReadableFallback = fallback;
            syncWrap(job.wrap, false);
          }
        }
        console.warn('[zh readable] contextual gloss failed:', error?.message || error);
      } finally {
        running.delete(job.key);
        workers = Math.max(0, workers - 1);
        pump();
      }
    })();
  }
}

function syncKey(key) {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(wrap => {
    if (wrap.dataset.zhReadableKey === key) syncWrap(wrap, false);
  });
}

function syncWrap(wrap, allowQueue = true) {
  const word = wrap?.querySelector?.(':scope > .reader-word');
  if (!word) return;
  if (!enabled() || wordState(word) !== 'unknown') {
    clearLanes(wrap);
    return;
  }

  const surface = clean(word.dataset.word || word.textContent || '');
  if (!surface) return;
  const context = paragraphContext(word) || surface;
  const key = contextKey(surface, context);
  wrap.dataset.zhReadableKey = key;

  const cached = loadCache()[key] || {};
  const pinyin = clean(cached.pinyin) || localPinyin(wrap, word);
  const manual = manualRussian(wrap);
  const cachedRu = compactRussian(cached.ru);
  const fallback = compactRussian(wrap.dataset.zhReadableFallback || '');
  const ru = cachedRu || manual || fallback || '';

  setLaneText(wrap, 'rw-zh-readable-pinyin', pinyin);
  setLaneText(wrap, 'rw-zh-readable-ru', ru);

  if (!cachedRu && !manual && allowQueue) enqueue(wrap, word, key, context, pinyin);
}

function syncAll() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(wrap => syncWrap(wrap));
  pump();
}

function schedule(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(syncAll, delay);
}

function installStyle() {
  LEGACY_STYLE_IDS.forEach(id => document.getElementById(id)?.remove());
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.02 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word) {
      display: inline-grid !important;
      grid-template-columns: max-content !important;
      grid-template-rows: auto auto auto !important;
      align-items: center !important;
      justify-items: center !important;
      vertical-align: -0.46em !important;
      line-height: 1 !important;
      margin: 0 .045em !important;
      padding: .015em .02em !important;
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      height: auto !important;
      overflow: visible !important;
      box-sizing: border-box !important;
      break-inside: avoid !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word) > .reader-word {
      grid-column: 1 !important;
      grid-row: 2 !important;
      display: inline !important;
      position: static !important;
      margin: 0 !important;
      padding: 0 1px !important;
      line-height: 1.04 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word) > .reader-word rt {
      display: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: none !important;
      display: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-readable-pinyin {
      grid-column: 1 !important;
      grid-row: 1 !important;
      align-self: end !important;
      justify-self: center !important;
      display: block !important;
      position: static !important;
      width: max-content !important;
      min-width: 0 !important;
      max-width: none !important;
      margin: 0 0 .09em !important;
      padding: 0 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
      text-align: center !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .42em !important;
      font-weight: 500 !important;
      line-height: 1 !important;
      color: color-mix(in srgb, var(--text-muted) 86%, var(--accent)) !important;
      pointer-events: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-readable-ru {
      grid-column: 1 !important;
      grid-row: 3 !important;
      align-self: start !important;
      justify-self: center !important;
      display: block !important;
      position: static !important;
      width: max-content !important;
      max-width: 5.6em !important;
      margin: .09em 0 0 !important;
      padding: 0 !important;
      white-space: normal !important;
      word-break: normal !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
      text-align: center !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .36em !important;
      font-weight: 400 !important;
      line-height: 1.08 !important;
      color: var(--text-muted) !important;
      pointer-events: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"] .rw-zh-readable-pinyin {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function bindObserver() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(bindObserver, 180);
    return;
  }
  if (observer && observedRoot === root) return;

  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(records => {
    let relevant = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target;
        if (!(target instanceof Element)) continue;
        const wrap = target.classList.contains('rw-zh-gloss-wrap')
          ? target
          : target.classList.contains('reader-word') && target.parentElement?.classList.contains('rw-zh-gloss-wrap')
            ? target.parentElement
            : null;
        if (wrap) {
          syncWrap(wrap);
          relevant = true;
        }
        continue;
      }

      for (const node of record.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('rw-zh-readable-pinyin') || node.classList.contains('rw-zh-readable-ru')) continue;
        if (node.classList.contains('rw-zh-gloss-wrap')) {
          syncWrap(node);
          relevant = true;
        }
        node.querySelectorAll?.('.rw-zh-gloss-wrap').forEach(wrap => {
          syncWrap(wrap);
          relevant = true;
        });
      }
    }
    if (relevant) schedule(20);
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'data-zh-gloss-pinyin',
      'data-zh-gloss-sticky-pinyin',
      'data-zh-gloss-ru',
      'data-zh-gloss-ru-readable',
      'data-zh-gloss-sticky-ru',
      'data-zh-gloss-source',
    ],
  });
}

function install() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  installStyle();
  bindObserver();
  schedule(0);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { installStyle(); bindObserver(); schedule(20); });
  window.addEventListener('scroll', () => schedule(90), { passive: true });
  window.addEventListener('reader-instant-word-translation', () => schedule(20));
  window.addEventListener('reader:zh-core-ready', () => schedule(20));
}

export { compactRussian, contextKey, syncWrap, syncAll };

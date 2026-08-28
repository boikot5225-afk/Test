// toc90 Chinese Unknown presentation.
//
// Important rule: Reader already has a correct native ruby/pinyin renderer.
// Do NOT draw a second pinyin lane. This module only adds one compact Russian
// gloss below Unknown words and lets the existing <ruby><rt> stay authoritative.

const STYLE_ID = 'reader-zh-readable-inline-v2';
const LEGACY_STYLE_IDS = [
  'reader-zh-readable-inline-v1',
  'reader-zh-stable-slots-v3',
  'reader-zh-unknown-interlinear-v1',
  'reader-zh-unknown-interlinear-v2',
  'rd-zh-unknown-gloss-spacing-style',
  'rd-zh-gloss-stability-v2-style',
  'reader-zh-toc88-inline-style',
];
const APP_URL = '../reader-app.js?v=77.32';
const CACHE_BASE = 'an2_reader_zh_context_gloss_v4';
const MAX_CONCURRENT = 2;
const RETRY_MS = 45_000;

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

// One visible meaning. Never a dictionary paragraph.
function compactRussian(value) {
  let text = clean(value);
  if (!hasRussian(text)) return '';

  // First sense only.
  text = text.split(/\s*(?:[;；/|·•]|[.!?。！？]|[,，])\s*/)[0] || text;
  // Remove both complete and broken parenthetical explanations.
  text = text
    .replace(/\s*[（(][^()（）]{0,80}[）)]/g, ' ')
    .replace(/\s*[（(].*$/, '')
    .replace(/^[—–-]\s*/, '')
    .replace(/[;；,.，。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  // Long prose like "Металл красноватого цвета" is not a usable inline gloss.
  if (text.length > 22) return words[0];
  return words.length > 2 ? words.slice(0, 2).join(' ') : text;
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
    clone.querySelectorAll('rt,.rw-zh-readable-ru,.rw-zh-readable-pinyin,.rw-zh-t88-py,.rw-zh-t88-ru')
      .forEach(node => node.remove());
    source = clean(clone.textContent).slice(0, 360);
  } catch {
    source = clean(paragraph.textContent).slice(0, 360);
  }
  paragraphTextCache.set(paragraph, source);
  return source;
}

function ensureRussianLane(wrap) {
  let lane = wrap.querySelector(':scope > .rw-zh-readable-ru');
  if (!lane) {
    lane = document.createElement('span');
    lane.className = 'rw-zh-readable-ru';
    lane.setAttribute('aria-hidden', 'true');
    wrap.appendChild(lane);
  }
  return lane;
}

function setRussianLane(wrap, value) {
  const lane = ensureRussianLane(wrap);
  const next = compactRussian(value);
  if (clean(lane.textContent) !== next) lane.textContent = next;
  lane.hidden = !next;
}

function clearCustomLanes(wrap) {
  wrap.querySelectorAll(':scope > .rw-zh-readable-pinyin,:scope > .rw-zh-t88-py,:scope > .rw-zh-t88-ru')
    .forEach(node => node.remove());
  if (!enabled() || wordState(wrap.querySelector(':scope > .reader-word')) !== 'unknown') {
    wrap.querySelector(':scope > .rw-zh-readable-ru')?.remove();
  }
}

function localRussian(wrap, word) {
  const fromWrap = wrap.dataset.zhGlossStickyRu
    || wrap.dataset.zhGlossRuReadable
    || wrap.dataset.zhGlossRu
    || '';
  const direct = compactRussian(fromWrap);
  if (direct) return direct;

  const surface = clean(word?.dataset?.word || word?.textContent || '');
  if (!surface) return '';
  try {
    const entry = globalThis.readerLookupChineseWord?.(surface) || null;
    return compactRussian(entry?.ru || entry?.russian || entry?.translation_ru || entry?.translation || '');
  } catch {
    return '';
  }
}

function manualRussian(wrap, word) {
  return wrap.dataset.zhGlossSource === 'instant' ? localRussian(wrap, word) : '';
}

function nativePinyin(word, wrap) {
  return clean(
    word?.querySelector?.('rt')?.textContent
    || wrap?.dataset?.zhGlossStickyPinyin
    || wrap?.dataset?.zhGlossPinyin
    || '',
  );
}

function updateNativePinyin(word, pinyin) {
  const next = clean(pinyin);
  if (!next) return;
  const rt = word?.querySelector?.('rt');
  if (rt && clean(rt.textContent) !== next) rt.textContent = next;
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
  return normalizeResult(await mod.readerAI({
    task: 'reader_word',
    sourceLang: 'zh',
    word,
    surface: word,
    context: clean(context).slice(0, 360) || word,
    hint: { pinyin },
  }));
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
        const surface = clean(job.word?.dataset?.word || job.word?.textContent || '');
        if (!surface) throw new Error('empty word');
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
        console.warn('[zh readable] contextual gloss failed:', error?.message || error);
        // Retry later, but do not hammer the service while offline.
        schedule(RETRY_MS + 500);
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
  clearCustomLanes(wrap);

  if (!enabled() || wordState(word) !== 'unknown') return;

  const surface = clean(word.dataset.word || word.textContent || '');
  if (!surface) return;
  const context = paragraphContext(word) || surface;
  const key = contextKey(surface, context);
  wrap.dataset.zhReadableKey = key;

  const cached = loadCache()[key] || {};
  const manual = manualRussian(wrap, word);
  const cachedRu = compactRussian(cached.ru);
  const fallback = localRussian(wrap, word);
  const ru = manual || cachedRu || fallback;
  setRussianLane(wrap, ru);

  if (cached.pinyin) updateNativePinyin(word, cached.pinyin);
  const pinyin = clean(cached.pinyin) || nativePinyin(word, wrap);

  // Always improve a dictionary fallback with the contextual reader_word result.
  if (!cachedRu && !manual && allowQueue) enqueue(wrap, word, key, context, pinyin);
}

function purgeLegacyVisuals(root = document) {
  LEGACY_STYLE_IDS.forEach(id => document.getElementById(id)?.remove());
  root?.querySelectorAll?.('.rw-zh-readable-pinyin,.rw-zh-t88-py,.rw-zh-t88-ru')
    .forEach(node => node.remove());
}

function syncAll() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  purgeLegacyVisuals(root);
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(wrap => syncWrap(wrap));
  pump();
}

function schedule(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(syncAll, delay);
}

function installStyle() {
  purgeLegacyVisuals();
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Normal Chinese stays normal. Only Unknown tokens become two-row units. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 1.90 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: contents !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap:has(> .reader-word.rw-migaku-unknown) {
      display: inline-flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: flex-start !important;
      vertical-align: -0.34em !important;
      line-height: 1 !important;
      margin: 0 .025em !important;
      padding: 0 !important;
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      height: auto !important;
      overflow: visible !important;
      box-sizing: border-box !important;
      break-inside: avoid !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap:has(> .reader-word.rw-migaku-unknown) > .reader-word {
      display: inline-block !important;
      position: static !important;
      margin: 0 !important;
      padding: 0 1px !important;
      line-height: 1.08 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
    }

    /* Reader's own ruby is the ONLY pinyin. Keep it complete and readable. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap:has(> .reader-word.rw-migaku-unknown) > .reader-word ruby.reader-ruby {
      ruby-position: over !important;
      ruby-align: center !important;
      line-height: 1.16 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap:has(> .reader-word.rw-migaku-unknown) > .reader-word rt {
      display: ruby-text !important;
      font-family: 'IBM Plex Mono', ui-monospace, monospace !important;
      font-size: .46em !important;
      font-weight: 400 !important;
      line-height: 1 !important;
      letter-spacing: 0 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow: visible !important;
      text-overflow: clip !important;
    }

    /* Kill every historical pseudo-lane. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: none !important;
      display: none !important;
      visibility: hidden !important;
    }

    /* One short Russian sense. It participates in layout vertically, so it can
       never paint over the Hanzi or the next text line. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-readable-ru {
      display: block !important;
      position: static !important;
      align-self: center !important;
      width: max-content !important;
      max-width: 4.8em !important;
      min-width: 0 !important;
      margin: .08em 0 0 !important;
      padding: 0 !important;
      white-space: normal !important;
      word-break: normal !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
      text-align: center !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .38em !important;
      font-weight: 400 !important;
      line-height: 1.08 !important;
      color: var(--text-muted) !important;
      pointer-events: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-readable-ru[hidden] {
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
        const el = record.target;
        if (el instanceof Element && (el.classList.contains('reader-word') || el.classList.contains('rw-zh-gloss-wrap'))) {
          relevant = true;
          break;
        }
      }
      for (const node of record.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('rw-zh-readable-ru')) continue;
        if (node.matches?.('.reader-word,.rw-zh-gloss-wrap') || node.querySelector?.('.reader-word,.rw-zh-gloss-wrap')) {
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (relevant) schedule(25);
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'data-zh-gloss-ru',
      'data-zh-gloss-ru-readable',
      'data-zh-gloss-sticky-ru',
      'data-zh-gloss-source',
      'data-zh-gloss-pinyin',
      'data-zh-gloss-sticky-pinyin',
    ],
  });
}

function install() {
  if (typeof document === 'undefined') return;
  installStyle();
  bindObserver();
  schedule(0);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { installStyle(); bindObserver(); schedule(20); });
  window.addEventListener('scroll', () => schedule(80), { passive: true });
  window.addEventListener('reader-instant-word-translation', () => schedule(20));
  window.addEventListener('reader:chromechange', () => schedule(20));
}

export { compactRussian, contextKey, syncWrap, syncAll };

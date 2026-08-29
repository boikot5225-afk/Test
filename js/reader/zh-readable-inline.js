// toc91 Chinese Unknown presentation.
//
// Non-negotiable layout rule: Chinese text keeps Reader's native geometry.
// Reader already owns Hanzi + ruby/pinyin. We only paint ONE short Russian
// contextual gloss inside the existing word line box. No flex/grid wrappers,
// no extra pinyin lane, no width reservation, no new line-break behaviour.

const STYLE_ID = 'reader-zh-readable-inline-v3';
const LEGACY_STYLE_IDS = [
  'reader-zh-readable-inline-v1',
  'reader-zh-readable-inline-v2',
  'reader-zh-stable-slots-v3',
  'reader-zh-unknown-interlinear-v1',
  'reader-zh-unknown-interlinear-v2',
  'rd-zh-unknown-gloss-spacing-style',
  'rd-zh-gloss-stability-v2-style',
  'reader-zh-toc88-inline-style',
];
const APP_URL = '../reader-app.js?v=77.32';
const CACHE_BASE = 'an2_reader_zh_context_gloss_v5';
const MAX_CONCURRENT = 3;
const RETRY_MS = 30_000;

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
  if (typeof document === 'undefined') return false;
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

function firstSense(value) {
  let text = clean(value);
  if (!text) return '';
  text = text.split(/\s*(?:[;；/|·•]|[.!?。！？]|[,，])\s*/)[0] || text;
  return text
    .replace(/\s*[（(][^()（）]{0,100}[）)]/g, ' ')
    .replace(/\s*[（(].*$/, '')
    .replace(/^[—–-]\s*/, '')
    .replace(/[;；,.，。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Final display formatter. One contextual sense, normally one Russian word,
// max two words. Never dictionary prose or a sentence fragment.
function compactRussian(value) {
  const text = firstSense(value);
  if (!text || !hasRussian(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.length > 2 ? words.slice(0, 2).join(' ') : text;
}

// Offline dictionary hints are useful only when they are already concise.
// Reject encyclopaedic prose instead of degrading "медь" into "Металл".
function safeDictionaryRussian(value) {
  const text = firstSense(value);
  if (!text || !hasRussian(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2 || text.length > 20) return '';
  if (/^(?:металл|вещество|материал|элемент|предмет|объект|название|термин)$/i.test(text)) return '';
  return text;
}

// Context service output is accepted only when it is actually a short gloss.
// A bad verbose answer stays invisible and is retried; it is never painted.
function contextualRussian(value) {
  const text = firstSense(value);
  if (!text || !hasRussian(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2 || text.length > 24) return '';
  if (/^(?:металл|вещество|материал|элемент)$/i.test(text)) return '';
  return text;
}

function wordState(word) {
  if (word?.classList?.contains('rw-migaku-unknown')) return 'unknown';
  if (word?.classList?.contains('rw-migaku-known') || word?.classList?.contains('rw-known')) return 'known';
  return '';
}

function wrapperFor(word) {
  const parent = word?.parentElement;
  return parent?.classList?.contains('rw-zh-gloss-wrap') ? parent : null;
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

// The gloss lives INSIDE .reader-word as an absolutely positioned child.
// Therefore it cannot increase token width/height or change line wrapping.
function ensureRussianLane(word) {
  let lane = word.querySelector(':scope > .rw-zh-readable-ru');
  if (!lane) {
    lane = document.createElement('span');
    lane.className = 'rw-zh-readable-ru';
    lane.setAttribute('aria-hidden', 'true');
    word.appendChild(lane);
  }
  return lane;
}

function setRussianLane(word, value) {
  const lane = ensureRussianLane(word);
  const next = compactRussian(value);
  if (clean(lane.textContent) !== next) lane.textContent = next;
  lane.hidden = !next;
}

function clearCustomLanes(word, wrap = wrapperFor(word)) {
  word?.querySelectorAll?.(':scope > .rw-zh-readable-pinyin,:scope > .rw-zh-t88-py,:scope > .rw-zh-t88-ru')
    .forEach(node => node.remove());
  wrap?.querySelectorAll?.(':scope > .rw-zh-readable-ru,:scope > .rw-zh-readable-pinyin,:scope > .rw-zh-t88-py,:scope > .rw-zh-t88-ru')
    .forEach(node => node.remove());
  if (!enabled() || wordState(word) !== 'unknown') {
    word?.querySelector?.(':scope > .rw-zh-readable-ru')?.remove();
  }
}

function rawLocalRussian(wrap, word) {
  const fromWrap = wrap?.dataset?.zhGlossStickyRu
    || wrap?.dataset?.zhGlossRuReadable
    || wrap?.dataset?.zhGlossRu
    || '';
  if (fromWrap) return fromWrap;

  const surface = clean(word?.dataset?.word || '');
  if (!surface) return '';
  try {
    const entry = globalThis.readerLookupChineseWord?.(surface) || null;
    return entry?.ru || entry?.russian || entry?.translation_ru || entry?.translation || '';
  } catch {
    return '';
  }
}

function localRussian(wrap, word) {
  return safeDictionaryRussian(rawLocalRussian(wrap, word));
}

function manualRussian(wrap, word) {
  if (wrap?.dataset?.zhGlossSource !== 'instant') return '';
  return contextualRussian(rawLocalRussian(wrap, word)) || safeDictionaryRussian(rawLocalRussian(wrap, word));
}

function nativePinyin(word, wrap) {
  return clean(
    word?.querySelector?.('rt')?.textContent
    || wrap?.dataset?.zhGlossStickyPinyin
    || wrap?.dataset?.zhGlossPinyin
    || '',
  );
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

function unwrapAIResult(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = clean(raw);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { ru: text };
}

function normalizeResult(raw) {
  const value = unwrapAIResult(raw);
  return contextualRussian(
    value?.ru
    || value?.translation_ru
    || value?.russian
    || value?.meaning_ru
    || value?.translation
    || '',
  );
}

async function requestContextMeaning(word, context, pinyin) {
  const mod = await app();
  if (typeof mod?.readerAI !== 'function') throw new Error('readerAI unavailable');
  const raw = await mod.readerAI({
    task: 'reader_word',
    sourceLang: 'zh',
    targetLang: 'ru',
    word,
    surface: word,
    context: clean(context).slice(0, 360) || word,
    hint: { pinyin },
    instruction: 'Translate ONLY this Chinese word in this exact context. Return JSON only: {"ru":"..."}. Russian only. Prefer exactly ONE Russian word; use at most TWO only if unavoidable. No English, no examples, no explanation, no sentence translation, no dictionary definition.',
  });
  return normalizeResult(raw);
}

function enqueue(word, key, context, pinyin) {
  if (!enabled() || queued.has(key) || running.has(key) || !isVisible(word)) return;
  const lastFailure = Number(failures.get(key) || 0);
  if (lastFailure && Date.now() - lastFailure < RETRY_MS) return;

  queued.add(key);
  queue.push({ word, key, context, pinyin });
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
        const surface = clean(job.word?.dataset?.word || '');
        if (!surface) throw new Error('empty word');
        const ru = await requestContextMeaning(surface, job.context, job.pinyin);
        if (!ru) throw new Error('context service did not return a compact Russian gloss');
        loadCache()[job.key] = { ru, t: Date.now() };
        saveCache();
        failures.delete(job.key);
        syncKey(job.key);
      } catch (error) {
        failures.set(job.key, Date.now());
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
  root.querySelectorAll('.reader-word[data-lang="zh"][data-word]').forEach(word => {
    if (word.dataset.zhReadableKey === key) syncWord(word, false);
  });
}

function syncWord(word, allowQueue = true) {
  if (!word?.classList?.contains('reader-word')) return;
  const wrap = wrapperFor(word);
  clearCustomLanes(word, wrap);

  if (!enabled() || wordState(word) !== 'unknown') return;

  const surface = clean(word.dataset.word || '');
  if (!surface) return;
  const context = paragraphContext(word) || surface;
  const key = contextKey(surface, context);
  word.dataset.zhReadableKey = key;

  const cached = loadCache()[key] || {};
  const manual = manualRussian(wrap, word);
  const cachedRu = contextualRussian(cached.ru);
  const fallback = localRussian(wrap, word);
  const ru = manual || cachedRu || fallback;
  setRussianLane(word, ru);

  // Never mutate <rt>. Reader's native pinyin renderer remains authoritative.
  const pinyin = nativePinyin(word, wrap);

  // Even when a safe dictionary fallback is visible, fetch the one contextual
  // meaning and replace it once. That is the requested final result.
  if (!cachedRu && !manual && allowQueue) enqueue(word, key, context, pinyin);
}

function purgeLegacyVisuals(root = document) {
  LEGACY_STYLE_IDS.forEach(id => document.getElementById(id)?.remove());
  root?.querySelectorAll?.('.rw-zh-readable-pinyin,.rw-zh-t88-py,.rw-zh-t88-ru')
    .forEach(node => node.remove());
  // toc90 put Russian lanes as siblings in the wrapper. Remove those leftovers;
  // toc91 keeps the only live lane inside .reader-word.
  root?.querySelectorAll?.('.rw-zh-gloss-wrap > .rw-zh-readable-ru')
    .forEach(node => node.remove());
}

function syncAll() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  purgeLegacyVisuals(root);
  paragraphTextCache.clear?.();
  root.querySelectorAll('.reader-word[data-lang="zh"][data-word]').forEach(word => syncWord(word));
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
    /* The data wrapper must be geometrically invisible. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: contents !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      height: auto !important;
    }

    /* Never resurrect old pseudo-element pinyin / dictionary lanes. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: none !important;
      display: none !important;
      visibility: hidden !important;
    }

    /* Positioning context only: relative positioning does not alter geometry. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .reader-word.rw-migaku-unknown {
      position: relative !important;
      overflow: visible !important;
    }

    /* One Russian contextual gloss, painted in the spare lower part of the
       existing CJK word line box. Absolute positioning means zero added width,
       zero added height, zero change to wrapping/pagination. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .reader-word.rw-migaku-unknown > .rw-zh-readable-ru {
      position: absolute !important;
      left: 50% !important;
      top: 1.16em !important;
      transform: translateX(-50%) !important;
      display: block !important;
      width: max-content !important;
      min-width: 0 !important;
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
      text-align: center !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .32em !important;
      font-weight: 400 !important;
      line-height: 1 !important;
      letter-spacing: 0 !important;
      color: var(--text-muted) !important;
      pointer-events: none !important;
      user-select: none !important;
      z-index: 2 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .reader-word.rw-migaku-unknown > .rw-zh-readable-ru[hidden] {
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
    if (relevant) schedule(20);
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
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  installStyle();
  bindObserver();
  schedule(0);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { installStyle(); bindObserver(); schedule(20); });
  window.addEventListener('scroll', () => schedule(70), { passive: true });
  window.addEventListener('reader-instant-word-translation', () => schedule(15));
  window.addEventListener('reader:chromechange', () => schedule(15));
}

export {
  compactRussian,
  safeDictionaryRussian,
  contextualRussian,
  contextKey,
  syncWord,
  syncAll,
};

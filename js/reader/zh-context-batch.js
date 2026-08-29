// toc98: contextual Chinese Unknown glosses for every paragraph visible on screen.
//
// toc94 still owns layout, pagination and Known/Unknown. This layer only writes
// Russian + contextual pinyin into the existing Unknown gloss slots. Visible
// paragraphs are processed sequentially (active first), so a page fills in
// without firing several DeepSeek calls at once or repaginating anything.

const CACHE_BASE_KEY = 'an2_reader_zh_context_gloss_v2';
const STYLE_ID = 'reader-zh-context-batch-style-v2';
const MAX_TARGETS = 18;
const MAX_VISIBLE_PARAGRAPHS = 5;
const SCAN_DELAY_MS = 80;
const RESOURCE_SETTLE_MS = 110;
const RETRY_MS = 20_000;
const CALL_TIMEOUT_MS = 65_000;
const CACHE_LIMIT = 2200;

const state = globalThis.__readerZhContextBatchV2 || {
  cache: null,
  inFlight: new Set(),
  timer: 0,
  observer: null,
  observedRoot: null,
  blockedUntil: 0,
  running: false,
};
globalThis.__readerZhContextBatchV2 = state;

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function currentOwner() {
  try {
    const owner = typeof globalThis.an2ReaderOwnerId === 'function' ? globalThis.an2ReaderOwnerId() : '';
    if (owner) return clean(owner, 80);
  } catch {}
  return 'anon';
}

function cacheStorageKey() {
  return `${CACHE_BASE_KEY}::${currentOwner()}`;
}

function hashText(value) {
  const text = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function loadCache() {
  if (state.cache instanceof Map) return state.cache;
  const map = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(cacheStorageKey()) || '{}');
    for (const [key, value] of Object.entries(raw || {})) {
      if (key && value && typeof value === 'object') map.set(key, value);
    }
  } catch {}
  state.cache = map;
  return map;
}

function saveCache() {
  const cache = loadCache();
  if (cache.size > CACHE_LIMIT) {
    const ordered = Array.from(cache.entries())
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, CACHE_LIMIT);
    cache.clear();
    ordered.forEach(([key, value]) => cache.set(key, value));
  }
  try { localStorage.setItem(cacheStorageKey(), JSON.stringify(Object.fromEntries(cache))); } catch {}
}

function enabled() {
  if (typeof document === 'undefined') return false;
  const view = document.getElementById('reader-reading-view');
  if (!view || String(view.dataset.readerLang || '').toLowerCase() !== 'zh') return false;
  try { return globalThis.readerGetZhUnknownGlossMode?.() === 'unknown'; }
  catch { return view.classList.contains('rd-zh-unknown-gloss'); }
}

function firebaseUserReady() {
  try {
    const firebase = globalThis.firebase;
    if (!firebase) return false;
    const auth = typeof firebase.auth === 'function' ? firebase.auth() : firebase.app?.()?.auth?.();
    return !!auth?.currentUser;
  } catch { return false; }
}

function paragraphContext(paragraph) {
  const source = paragraph?.querySelector?.('.reader-paragraph-text');
  if (!source) return '';
  const clone = source.cloneNode(true);
  clone.querySelectorAll?.(
    '.rw-zh-readable-ru,.rw-zh-readable-pinyin,.rw-zh-t88-py,.rw-zh-t88-ru,rt,[aria-hidden="true"]',
  ).forEach(node => node.remove());
  return clean(clone.textContent || '', 1200);
}

function visibleParagraphs() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const paragraphs = Array.from(root.querySelectorAll('.reader-paragraph'));
  if (!paragraphs.length) return [];

  const active = root.querySelector('.reader-paragraph.active');
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  const viewRect = document.getElementById('reader-reading-view')?.getBoundingClientRect?.();
  const topLimit = Math.max(0, Number(viewRect?.top || 0) - 80);
  const bottomLimit = Math.min(
    viewportHeight || Number(viewRect?.bottom || 0),
    Number(viewRect?.bottom || viewportHeight || 0) + 80,
  );

  const visible = paragraphs.filter((paragraph) => {
    try {
      const rect = paragraph.getBoundingClientRect();
      if (!rect || rect.height <= 0 || rect.width <= 0) return false;
      return rect.bottom >= topLimit && rect.top <= bottomLimit;
    } catch { return false; }
  });

  const ordered = [];
  if (active && (visible.includes(active) || !visible.length)) ordered.push(active);
  for (const paragraph of visible) {
    if (!ordered.includes(paragraph)) ordered.push(paragraph);
    if (ordered.length >= MAX_VISIBLE_PARAGRAPHS) break;
  }
  if (!ordered.length && active) ordered.push(active);
  return ordered.slice(0, MAX_VISIBLE_PARAGRAPHS);
}

function unknownOccurrences(paragraph, context) {
  if (!paragraph || !context) return [];
  const allWords = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const contextHash = hashText(context);
  const out = [];
  allWords.forEach((word, tokenIndex) => {
    if (!word.classList.contains('rw-migaku-unknown')) return;
    const surface = clean(word.dataset.word || word.textContent, 32);
    if (!surface || !/[\u3400-\u9fff]/.test(surface)) return;
    const wrap = word.closest('.rw-zh-gloss-wrap');
    if (!wrap) return;
    const cacheKey = `${contextHash}:${tokenIndex}:${surface}`;
    out.push({ word, wrap, surface, tokenIndex, cacheKey, id: `t${tokenIndex}` });
  });
  return out;
}

function compactRu(value) {
  const text = clean(value, 42)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?。！？]+$/g, '')
    .trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return '';
  return text;
}

function compactPinyin(value) {
  const text = clean(value, 72);
  if (!text || /[\u0400-\u052f\u4e00-\u9fff]/.test(text)) return '';
  return text;
}

function directPaint(wrap, pinyin, ru) {
  if (!wrap?.isConnected) return;
  const lane = wrap.querySelector(':scope > .rw-zh-readable-ru');
  if (!lane) return;
  const py = lane.querySelector(':scope > .rw-zh-readable-py');
  const meaning = lane.querySelector(':scope > .rw-zh-readable-meaning');
  if (py && pinyin) {
    py.textContent = pinyin;
    py.hidden = false;
  }
  if (meaning && ru) {
    meaning.textContent = ru;
    meaning.hidden = false;
  }
  if ((pinyin || ru) && lane.hidden) lane.hidden = false;
}

function applyResult(occurrence, result, { cached = false } = {}) {
  const wrap = occurrence?.wrap;
  if (!wrap?.isConnected) return;
  const ru = compactRu(result?.ru);
  const pinyin = compactPinyin(result?.pinyin);
  const confidence = Math.max(0, Math.min(1, Number(result?.confidence || 0)));
  const boundary = String(result?.boundary || '').toLowerCase() === 'suspect' ? 'suspect' : 'ok';

  delete wrap.dataset.zhContextPending;
  delete wrap.dataset.zhContextNoFallback;
  wrap.dataset.zhContextSource = cached ? 'cache' : 'deepseek_batch';
  wrap.dataset.zhContextConfidence = confidence.toFixed(2);
  wrap.dataset.zhContextBoundary = boundary;
  if (result?.suggestion) wrap.dataset.zhContextSuggestion = clean(result.suggestion, 48);
  else delete wrap.dataset.zhContextSuggestion;

  if (ru) {
    wrap.dataset.zhGlossStickyRu = ru;
    wrap.dataset.zhGlossSource = 'context-ai';
  } else if (boundary === 'suspect') {
    wrap.dataset.zhContextNoFallback = '1';
  }
  if (pinyin && confidence >= 0.72) wrap.dataset.zhGlossStickyPinyin = pinyin;

  // toc94's old compact filter allows only very short hints. Paint the exact
  // contextual result into its existing lane too, so a legitimate 3-word
  // gloss is not silently discarded. No elements are created or moved here.
  directPaint(wrap, pinyin && confidence >= 0.72 ? pinyin : '', ru);
}

function dictionaryHint(surface) {
  try { globalThis.readerLookupChineseResource?.(surface); } catch {}
  let entry = null;
  try { entry = globalThis.readerLookupChineseWord?.(surface) || null; } catch {}
  if (!entry || typeof entry !== 'object') return { surface };
  return {
    surface,
    pinyin: clean(entry.pinyin || entry.py || entry.pinyin_marked, 72),
    en: clean(entry.en || entry.english || entry.definition || entry.gloss, 220),
    alt: clean(entry.alt, 80),
    hsk: clean(entry.hsk || entry.level, 24),
    newHsk: clean(entry.newHsk, 24),
    blcuRank: Number.isFinite(Number(entry.blcuRank)) ? Number(entry.blcuRank) : null,
    subtlexRank: Number.isFinite(Number(entry.subtlexRank)) ? Number(entry.subtlexRank) : null,
    jiebaRank: Number.isFinite(Number(entry.jiebaRank)) ? Number(entry.jiebaRank) : null,
  };
}

function functionRegion() {
  return clean(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1', 40) || 'asia-southeast1';
}

async function callBatch(context, occurrences) {
  const firebase = globalThis.firebase;
  if (!firebase?.app) throw new Error('Firebase недоступен');
  const fn = firebase.app().functions(functionRegion()).httpsCallable('readerAI');
  const targets = occurrences.map(item => ({ id: item.id, ...dictionaryHint(item.surface) }));
  const work = fn({ task: 'zh_context_batch', sourceLang: 'zh', context, targets });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('readerAI zh_context_batch timeout')), CALL_TIMEOUT_MS);
  });
  const result = await Promise.race([work, timeout]);
  const payload = result?.data?.data || result?.data || {};
  return Array.isArray(payload?.items) ? payload.items : [];
}

function applyCachedForParagraph(paragraph, context) {
  const cache = loadCache();
  const all = unknownOccurrences(paragraph, context);
  let changed = false;
  for (const occurrence of all) {
    const cached = cache.get(occurrence.cacheKey);
    if (!cached) continue;
    applyResult(occurrence, cached, { cached: true });
    changed = true;
  }
  return { all, changed };
}

async function fillOneParagraph(paragraph, context, all) {
  const cache = loadCache();
  const batch = all
    .filter(item => !cache.has(item.cacheKey) && !state.inFlight.has(item.cacheKey))
    .slice(0, MAX_TARGETS);
  if (!batch.length) return false;

  batch.forEach(item => {
    try { globalThis.readerLookupChineseResource?.(item.surface); } catch {}
    state.inFlight.add(item.cacheKey);
    item.wrap.dataset.zhContextPending = '1';
  });

  try {
    await new Promise(resolve => setTimeout(resolve, RESOURCE_SETTLE_MS));
    const items = await callBatch(context, batch);
    const byId = new Map(items.map(item => [clean(item?.id, 40), item]));
    let changed = false;

    for (const occurrence of batch) {
      state.inFlight.delete(occurrence.cacheKey);
      const result = byId.get(occurrence.id) || null;
      if (!result) {
        delete occurrence.wrap?.dataset?.zhContextPending;
        continue;
      }
      const stored = {
        ru: compactRu(result.ru),
        pinyin: compactPinyin(result.pinyin),
        confidence: Math.max(0, Math.min(1, Number(result.confidence || 0))),
        boundary: String(result.boundary || '').toLowerCase() === 'suspect' ? 'suspect' : 'ok',
        suggestion: clean(result.suggestion, 48),
        ts: Date.now(),
      };
      cache.set(occurrence.cacheKey, stored);
      applyResult(occurrence, stored);
      changed = true;
    }

    if (changed) saveCache();
    return changed;
  } catch (error) {
    batch.forEach(item => {
      state.inFlight.delete(item.cacheKey);
      delete item.wrap?.dataset?.zhContextPending;
    });
    state.blockedUntil = Date.now() + RETRY_MS;
    console.warn('[zh context batch] unavailable, keeping toc94 fallback:', error?.message || error);
    return false;
  }
}

async function processVisibleParagraphs() {
  state.timer = 0;
  if (state.running || !enabled() || Date.now() < state.blockedUntil) return;
  if (!firebaseUserReady()) return;
  state.running = true;

  try {
    const paragraphs = visibleParagraphs();
    if (!paragraphs.length) return;
    let cachedChanged = false;

    // First repaint every cached visible result immediately, active paragraph
    // first. Then spend at most one network call per pass on the first visible
    // paragraph that still has unresolved Unknowns. A follow-up pass moves to
    // the next paragraph, keeping network/UI load bounded.
    const prepared = [];
    for (const paragraph of paragraphs) {
      const context = paragraphContext(paragraph);
      if (!context) continue;
      const { all, changed } = applyCachedForParagraph(paragraph, context);
      cachedChanged ||= changed;
      if (all.length) prepared.push({ paragraph, context, all });
    }

    if (cachedChanged) {
      try { window.dispatchEvent(new CustomEvent('reader-instant-word-translation')); } catch {}
    }

    for (const item of prepared) {
      const unresolved = item.all.some(x => !loadCache().has(x.cacheKey) && !state.inFlight.has(x.cacheKey));
      if (!unresolved) continue;
      const changed = await fillOneParagraph(item.paragraph, item.context, item.all);
      if (changed) {
        try {
          window.dispatchEvent(new CustomEvent('reader-instant-word-translation'));
          // Repaint after toc94's listener has synced its lanes; this keeps
          // valid 3-word contextual glosses instead of letting its old 2-word
          // filter erase them.
          queueMicrotask(() => {
            const contextNow = paragraphContext(item.paragraph);
            if (contextNow) applyCachedForParagraph(item.paragraph, contextNow);
          });
          window.dispatchEvent(new CustomEvent('reader:zh-context-ready', {
            detail: { contextHash: hashText(item.context), count: item.all.length },
          }));
        } catch {}
      }
      schedule(140);
      return;
    }
  } finally {
    state.running = false;
  }
}

function schedule(delay = SCAN_DELAY_MS) {
  clearTimeout(state.timer);
  state.timer = setTimeout(processVisibleParagraphs, delay);
}

function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  document.getElementById('reader-zh-context-batch-style-v1')?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-context-pending="1"] .rw-zh-readable-meaning,
    #reader-reading-view[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-context-no-fallback="1"] .rw-zh-readable-meaning {
      visibility: hidden !important;
    }
  `;
  document.head.appendChild(style);
}

function bindObserver() {
  const root = document.getElementById('reader-chapter-text');
  if (!root || typeof MutationObserver === 'undefined') {
    setTimeout(bindObserver, 180);
    return;
  }
  if (state.observer && state.observedRoot === root) return;
  state.observer?.disconnect();
  state.observedRoot = root;
  state.observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target;
        if (el?.classList?.contains('reader-paragraph') || el?.classList?.contains('reader-word')) {
          schedule(45);
          return;
        }
      }
      if (record.addedNodes?.length) {
        schedule(70);
        return;
      }
    }
  });
  state.observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}

function install() {
  if (typeof document === 'undefined') return;
  installStyle();
  bindObserver();
  schedule(120);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { bindObserver(); schedule(90); });
  window.addEventListener('scroll', () => schedule(120), { passive: true });
  window.addEventListener('resize', () => schedule(120), { passive: true });
  window.addEventListener('reader:zh-resource-ready', () => schedule(80));
  window.addEventListener('reader:chromechange', () => schedule(80));
}

export { paragraphContext, visibleParagraphs, unknownOccurrences, dictionaryHint, processVisibleParagraphs };

// toc100: direct Chinese -> Russian fallback for every visible Unknown word.
//
// Android owns the ML Kit translator. This module only asks for translations
// and writes a short Russian hint into toc94's already-existing gloss slot.
// Context AI remains authoritative and may replace this fallback later.

const CACHE_KEY = 'an2_reader_zh_mlkit_ru_v1';
const MAX_BATCH = 40;
const CACHE_LIMIT = 3000;
const RETRY_MS = 20_000;
const CONTEXT_GRACE_MS = 2_200;

const state = globalThis.__readerZhDirectRuV1 || {
  cache: null,
  queued: new Set(),
  inFlight: new Set(),
  requests: new Map(),
  timer: 0,
  sequence: 0,
  blockedUntil: 0,
  observer: null,
  observedRoot: null,
  lastError: '',
};
globalThis.__readerZhDirectRuV1 = state;

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactRu(value) {
  const text = clean(value, 56)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?。！？]+$/g, '')
    .trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.slice(0, 4).join(' ').slice(0, 42).trim();
}

function enabled() {
  const view = document.getElementById('reader-reading-view');
  if (!view || String(view.dataset.readerLang || '').toLowerCase() !== 'zh') return false;
  try { return globalThis.readerGetZhUnknownGlossMode?.() === 'unknown'; }
  catch { return view.classList.contains('rd-zh-unknown-gloss'); }
}

function loadCache() {
  if (state.cache instanceof Map) return state.cache;
  const map = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    for (const [word, ru] of Object.entries(raw || {})) {
      const cleanRu = compactRu(ru);
      if (word && cleanRu) map.set(word, cleanRu);
    }
  } catch {}
  state.cache = map;
  return map;
}

function saveCache() {
  const cache = loadCache();
  if (cache.size > CACHE_LIMIT) {
    const keep = Array.from(cache.entries()).slice(-CACHE_LIMIT);
    cache.clear();
    keep.forEach(([key, value]) => cache.set(key, value));
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache))); } catch {}
}

function visibleParagraphs() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const paragraphs = Array.from(root.querySelectorAll('.reader-paragraph'));
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  const viewRect = document.getElementById('reader-reading-view')?.getBoundingClientRect?.();
  const topLimit = Math.max(0, Number(viewRect?.top || 0) - 100);
  const bottomLimit = Math.min(
    viewportHeight || Number(viewRect?.bottom || 0),
    Number(viewRect?.bottom || viewportHeight || 0) + 100,
  );
  return paragraphs.filter(paragraph => {
    try {
      const rect = paragraph.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0
        && rect.bottom >= topLimit && rect.top <= bottomLimit;
    } catch { return false; }
  }).slice(0, 6);
}

function visibleUnknowns() {
  const out = [];
  for (const paragraph of visibleParagraphs()) {
    const wraps = paragraph.querySelectorAll('.rw-zh-gloss-wrap');
    for (const wrap of wraps) {
      const word = wrap.querySelector(':scope > .reader-word.rw-migaku-unknown[data-word]');
      if (!word) continue;
      const surface = clean(word.dataset.word || word.textContent, 32);
      if (!surface || !/[\u3400-\u9fff]/.test(surface)) continue;
      out.push({ wrap, word, surface });
    }
  }
  return out;
}

function contextOverrideRu(wrap) {
  const source = String(wrap?.dataset?.zhGlossSource || '');
  const explicit = compactRu(wrap?.dataset?.zhGlossContextRu || '');
  if (explicit) return explicit;
  if ((source === 'context-ai' || source === 'context-panel') && compactRu(wrap?.dataset?.zhGlossStickyRu)) {
    return compactRu(wrap.dataset.zhGlossStickyRu);
  }
  const word = wrap?.querySelector?.(':scope > .reader-word[data-word]');
  const surface = clean(word?.dataset?.word || word?.textContent || '', 32);
  const paragraphIndex = Number(word?.closest?.('.reader-paragraph')?.dataset?.p);
  if (!surface) return '';
  try {
    return compactRu(globalThis.readerGetCachedChineseContextRuForInline?.(surface, paragraphIndex) || '');
  } catch {
    return '';
  }
}

function hasContextOverride(wrap) {
  return !!contextOverrideRu(wrap);
}

function applyToWrap(wrap, ru) {
  if (!wrap?.isConnected) return false;
  const value = compactRu(ru);
  if (!value) return false;
  if (hasContextOverride(wrap)) return false;
  wrap.dataset.zhGlossStickyRu = value;
  wrap.dataset.zhGlossSource = 'mlkit-zh-ru';
  wrap.dataset.zhDirectRu = '1';
  const lane = wrap.querySelector(':scope > .rw-zh-readable-ru');
  const meaning = lane?.querySelector(':scope > .rw-zh-readable-meaning');
  if (meaning) {
    meaning.textContent = value;
    meaning.hidden = false;
    lane.hidden = false;
  }
  return true;
}

function applyWord(surface, ru) {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return 0;
  let changed = 0;
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(wrap => {
    const word = wrap.querySelector(':scope > .reader-word.rw-migaku-unknown[data-word]');
    if (!word) return;
    if (clean(word.dataset.word || word.textContent, 32) !== surface) return;
    if (applyToWrap(wrap, ru)) changed += 1;
  });
  return changed;
}

function queueVisible() {
  if (!enabled() || Date.now() < state.blockedUntil) return;
  const bridge = globalThis.ReaderChineseTranslate;
  if (!bridge || typeof bridge.translateBatch !== 'function') return;

  const cache = loadCache();
  let painted = false;
  for (const item of visibleUnknowns()) {
    if (hasContextOverride(item.wrap)) continue;
    const cached = cache.get(item.surface);
    if (cached) {
      painted = applyToWrap(item.wrap, cached) || painted;
      continue;
    }
    if (!state.inFlight.has(item.surface)) state.queued.add(item.surface);
  }
  if (painted) {
    try { window.dispatchEvent(new CustomEvent('reader-instant-word-translation')); } catch {}
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(flush, 40);
}

function flush() {
  state.timer = 0;
  if (!enabled() || Date.now() < state.blockedUntil) return;
  const bridge = globalThis.ReaderChineseTranslate;
  if (!bridge || typeof bridge.translateBatch !== 'function') return;
  const words = Array.from(state.queued).filter(word => !state.inFlight.has(word)).slice(0, MAX_BATCH);
  if (!words.length) return;
  words.forEach(word => {
    state.queued.delete(word);
    state.inFlight.add(word);
  });
  const id = `zhru-${Date.now().toString(36)}-${(++state.sequence).toString(36)}`;
  state.requests.set(id, words);
  try {
    bridge.translateBatch(id, JSON.stringify(words));
  } catch (error) {
    state.requests.delete(id);
    words.forEach(word => state.inFlight.delete(word));
    state.lastError = clean(error?.message || error || 'native bridge failed', 180);
    state.blockedUntil = Date.now() + RETRY_MS;
  }
}

function accept(source, translated) {
  const word = clean(source, 32);
  const ru = compactRu(translated);
  if (!word) return false;
  state.inFlight.delete(word);
  if (!ru) return false;
  loadCache().set(word, ru);
  applyWord(word, ru);
  return true;
}

function parsePayload(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function bindBridgeCallbacks() {
  globalThis.__readerChineseTranslateProgress = (requestId, source, translated) => {
    if (accept(source, translated)) {
      saveCache();
      try { window.dispatchEvent(new CustomEvent('reader-instant-word-translation')); } catch {}
    }
  };
  globalThis.__readerChineseTranslateResolve = (requestId, ok, payloadJson) => {
    const id = String(requestId || '');
    const requested = state.requests.get(id) || [];
    state.requests.delete(id);
    requested.forEach(word => state.inFlight.delete(word));
    const payload = parsePayload(payloadJson);
    if (ok) {
      let changed = false;
      const translations = payload.translations && typeof payload.translations === 'object'
        ? payload.translations : {};
      Object.entries(translations).forEach(([source, translated]) => {
        changed = accept(source, translated) || changed;
      });
      state.lastError = '';
      if (changed) {
        saveCache();
        try { window.dispatchEvent(new CustomEvent('reader-instant-word-translation')); } catch {}
      }
    } else {
      state.lastError = clean(payload.message || 'ML Kit Chinese→Russian unavailable', 180);
      state.blockedUntil = Date.now() + RETRY_MS;
    }
    setTimeout(queueVisible, 80);
  };
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
  state.observer = new MutationObserver(() => setTimeout(queueVisible, CONTEXT_GRACE_MS));
  state.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function install() {
  bindBridgeCallbacks();
  bindObserver();
  setTimeout(queueVisible, CONTEXT_GRACE_MS);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { bindObserver(); queueVisible(); });
  window.addEventListener('scroll', () => setTimeout(queueVisible, 100), { passive: true });
  window.addEventListener('resize', () => setTimeout(queueVisible, 100), { passive: true });
  window.addEventListener('reader:zh-resource-ready', () => setTimeout(queueVisible, CONTEXT_GRACE_MS));
}

globalThis.readerZhDirectRuStats = () => ({
  nativeAvailable: !!globalThis.ReaderChineseTranslate?.translateBatch,
  cacheSize: loadCache().size,
  queued: state.queued.size,
  inFlight: state.inFlight.size,
  blockedUntil: state.blockedUntil,
  lastError: state.lastError,
});

export { compactRu, visibleUnknowns, queueVisible };

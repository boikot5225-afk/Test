// toc107 — native Mandarin segmentation gate.
// Uses the bundled SQLite bridge before the active Chinese paragraph is painted,
// so token boundaries do not jump after reading has started.

const CACHE_KEY = 'an2_zh_native_segment_v1';
const CACHE_MAX = 500;
const pending = new Map();
let seq = 0;
let cache = null;

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
  catch { cache = {}; }
  return cache;
}

function hashText(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(text) {
  const s = String(text || '');
  return `${hashText(s)}:${s.length}`;
}

function saveCache() {
  const c = loadCache();
  const keys = Object.keys(c).sort((a, b) => Number(c[b]?.t || 0) - Number(c[a]?.t || 0));
  for (const key of keys.slice(CACHE_MAX)) delete c[key];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
}

function validTokens(text, tokens) {
  return Array.isArray(tokens) && tokens.length > 0 && tokens.join('') === String(text || '');
}

function getSync(text) {
  const s = String(text || '');
  if (!s || !/[\u3400-\u9fff]/.test(s)) return null;
  const hit = loadCache()[cacheKey(s)];
  return validTokens(s, hit?.tokens) ? hit.tokens.slice() : null;
}

function bridge() {
  const b = globalThis.ReaderChineseResources;
  return b && typeof b.segmentText === 'function' ? b : null;
}

function ensure(text) {
  const s = String(text || '');
  if (!s || !/[\u3400-\u9fff]/.test(s)) return Promise.resolve(null);
  const ready = getSync(s);
  if (ready) return Promise.resolve(ready);
  const b = bridge();
  if (!b) return Promise.resolve(null);

  const key = cacheKey(s);
  if (pending.has(key)) return pending.get(key).promise;

  const requestId = `zhseg-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  pending.set(key, { requestId, text: s, resolve: resolvePromise, promise });
  try {
    b.segmentText(requestId, s);
  } catch (error) {
    pending.delete(key);
    resolvePromise(null);
  }
  return promise;
}

globalThis.__readerChineseSegmentResolve = function readerChineseSegmentResolve(requestId, ok, rawPayload) {
  let payload = rawPayload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  const item = Array.from(pending.values()).find(entry => entry.requestId === String(requestId || ''));
  if (!item) return;
  const key = cacheKey(item.text);
  pending.delete(key);
  const tokens = ok && validTokens(item.text, payload?.tokens) ? payload.tokens.slice() : null;
  if (tokens) {
    loadCache()[key] = { tokens, t: Date.now(), provider: payload?.provider || 'native-sqlite-dp' };
    saveCache();
  }
  item.resolve(tokens);
};

function prefetch(texts) {
  for (const text of Array.isArray(texts) ? texts : []) {
    ensure(text).catch(() => null);
  }
}

globalThis.readerNativeChineseSegmentationSync = getSync;
globalThis.readerEnsureNativeChineseSegmentation = ensure;
globalThis.readerPrefetchNativeChineseSegmentation = prefetch;
globalThis.readerNativeChineseSegmentationStats = () => ({
  cached: Object.keys(loadCache()).length,
  pending: pending.size,
  nativeAvailable: !!bridge(),
});

export { getSync, ensure, prefetch };

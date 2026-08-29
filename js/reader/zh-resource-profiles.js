// Reader AI toc96: lazy supplemental Chinese resources.
//
// The full Migaku Mandarin dictionary + BLCU / SUBTLEX-CH / Jieba / HSK data
// live in a bundled SQLite database on Android. This module never downloads or
// parses the 500k-entry dictionary in WebView memory. It only asks the native
// read-only bridge for words that Reader actually touches, in small batches.
//
// Contract:
// - NEVER owns Chinese layout/pagination;
// - NEVER changes the calibrated 39,999-word Known/Unknown scale;
// - existing Reader dictionary remains authoritative when it has a value;
// - Migaku resources fill missing pinyin/English and add frequency/HSK metadata;
// - browser/Firebase builds without the native bridge silently keep toc94 behavior.

const STATE_KEY = '__readerZhResourceLayerV2';
const MANIFEST_URL = '/assets/data/zh_migaku_manifest.json';
const MAX_BATCH = 60;
const FLUSH_DELAY_MS = 24;

const state = globalThis[STATE_KEY] || {
  cache: new Map(),
  misses: new Set(),
  queued: new Set(),
  pending: new Map(),
  timer: 0,
  sequence: 0,
  manifest: null,
  manifestPromise: null,
  lookupBridgeInstalled: false,
  nativeAvailable: false,
  error: '',
  received: 0,
};
globalThis[STATE_KEY] = state;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeWord(value) {
  return clean(value);
}

function nativeBridge() {
  const bridge = globalThis.ReaderChineseResources;
  state.nativeAvailable = !!(bridge && typeof bridge.lookupBatch === 'function');
  return state.nativeAvailable ? bridge : null;
}

function frequencyMeta(entry) {
  if (!entry) return null;
  const meta = {
    word: clean(entry.word || entry.surface),
    blcuRank: Number.isFinite(Number(entry.blcuRank)) ? Number(entry.blcuRank) : null,
    subtlexRank: Number.isFinite(Number(entry.subtlexRank)) ? Number(entry.subtlexRank) : null,
    jiebaRank: Number.isFinite(Number(entry.jiebaRank)) ? Number(entry.jiebaRank) : null,
    hsk: clean(entry.hsk),
    newHsk: clean(entry.newHsk),
  };
  return meta.blcuRank != null || meta.subtlexRank != null || meta.jiebaRank != null || meta.hsk || meta.newHsk
    ? meta
    : null;
}

function resourceLookup(word, { queue = true } = {}) {
  const normalized = normalizeWord(word);
  if (!normalized) return null;
  const hit = state.cache.get(normalized) || null;
  if (hit) return hit;
  if (queue && !state.misses.has(normalized)) queueWord(normalized);
  return null;
}

function metaForWord(word) {
  return frequencyMeta(resourceLookup(word));
}

function mergeLookup(primary, extra, originalWord) {
  if (!primary && !extra) return null;
  const base = primary && typeof primary === 'object' ? primary : {};
  const fallback = extra && typeof extra === 'object' ? extra : {};
  const meta = frequencyMeta(fallback);
  const merged = {
    ...fallback,
    ...base,
    word: clean(base.word || fallback.word || originalWord),
    surface: clean(base.surface || fallback.surface || originalWord),
    lemma: clean(base.lemma || fallback.word || originalWord),
    pinyin: clean(base.pinyin || base.py || base.pinyin_marked || fallback.pinyin),
    en: clean(base.en || base.english || base.definition || fallback.en),
    ru: clean(base.ru || base.translation_ru || base.russian),
    alt: clean(base.alt || fallback.alt),
    tags: clean(base.tags || fallback.tags),
    frequency: meta || base.frequency || null,
    blcuRank: fallback.blcuRank ?? base.blcuRank ?? null,
    subtlexRank: fallback.subtlexRank ?? base.subtlexRank ?? null,
    jiebaRank: fallback.jiebaRank ?? base.jiebaRank ?? null,
    hsk: clean(base.hsk || base.level || fallback.hsk),
    newHsk: clean(base.newHsk || fallback.newHsk),
  };
  if (primary) {
    merged._source = base._source || 'reader_core';
    merged._note = base._note || 'локальный китайский словарь';
    if (extra) merged._resourceSupplement = 'migaku_sqlite';
  } else {
    merged._source = fallback._source || 'migaku_sqlite_offline';
    merged._note = fallback._note || 'дополнительный локальный словарь Migaku';
  }
  return merged;
}

function queueWord(word) {
  const normalized = normalizeWord(word);
  if (!normalized || state.cache.has(normalized) || state.misses.has(normalized) || state.queued.has(normalized)) return;
  if (!nativeBridge()) return;
  state.queued.add(normalized);
  if (!state.timer) {
    state.timer = setTimeout(flushQueue, FLUSH_DELAY_MS);
  }
}

function flushQueue() {
  state.timer = 0;
  const bridge = nativeBridge();
  if (!bridge || !state.queued.size) return;

  const words = [];
  for (const word of state.queued) {
    state.queued.delete(word);
    words.push(word);
    if (words.length >= MAX_BATCH) break;
  }
  if (!words.length) return;

  const requestId = `zhres-${Date.now().toString(36)}-${(++state.sequence).toString(36)}`;
  state.pending.set(requestId, words);
  try {
    bridge.lookupBatch(requestId, JSON.stringify(words));
  } catch (error) {
    state.pending.delete(requestId);
    state.error = clean(error?.message || error || 'native lookup failed');
  }

  if (state.queued.size && !state.timer) {
    state.timer = setTimeout(flushQueue, FLUSH_DELAY_MS);
  }
}

function parsePayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function emitUpdated(words) {
  if (!words?.length) return;
  try {
    window.dispatchEvent(new CustomEvent('reader:zh-resource-ready', {
      detail: {
        words,
        cacheSize: state.cache.size,
        manifest: state.manifest,
      },
    }));
    // Existing toc94 Unknown gloss code already listens to this event and
    // performs an in-place rescan. No pagination/navigation state is changed.
    window.dispatchEvent(new CustomEvent('reader:zh-core-ready', {
      detail: { source: 'migaku_sqlite', words },
    }));
  } catch {}
}

globalThis.__readerChineseResourceResolve = function resolveChineseResource(requestId, ok, rawPayload) {
  const requested = state.pending.get(String(requestId || '')) || [];
  state.pending.delete(String(requestId || ''));
  const payload = parsePayload(rawPayload);

  if (!ok) {
    state.error = clean(payload?.message || 'native Chinese resource lookup failed');
    // Failed I/O is retryable; do not poison the miss cache.
    return;
  }

  state.error = '';
  const entries = payload?.entries && typeof payload.entries === 'object' ? payload.entries : {};
  const receivedWords = [];
  const returned = new Set();

  for (const [requestedWord, rawEntry] of Object.entries(entries)) {
    const key = normalizeWord(requestedWord);
    if (!key || !rawEntry || typeof rawEntry !== 'object') continue;
    const entry = Object.freeze({
      ...rawEntry,
      word: clean(rawEntry.word || key),
      surface: clean(rawEntry.surface || key),
      pinyin: clean(rawEntry.pinyin),
      en: clean(rawEntry.en),
      alt: clean(rawEntry.alt),
      tags: clean(rawEntry.tags),
      hsk: clean(rawEntry.hsk),
      newHsk: clean(rawEntry.newHsk),
    });
    state.cache.set(key, entry);
    state.misses.delete(key);
    returned.add(key);
    receivedWords.push(key);
    state.received += 1;
  }

  for (const word of requested) {
    if (!returned.has(word) && !state.cache.has(word)) state.misses.add(word);
  }

  emitUpdated(receivedWords);
};

function installLookupBridge() {
  if (state.lookupBridgeInstalled) return true;
  const current = globalThis.readerLookupChineseWord;
  if (typeof current !== 'function') return false;
  if (current.__readerZhResourceBridgeV2) {
    state.lookupBridgeInstalled = true;
    return true;
  }

  const wrapped = function readerLookupChineseWordWithResources(word) {
    let primary = null;
    try { primary = current(word) || null; } catch {}
    const extra = resourceLookup(word, { queue: true });
    return mergeLookup(primary, extra, word);
  };
  Object.defineProperty(wrapped, '__readerZhResourceBridgeV2', { value: true });
  Object.defineProperty(wrapped, '__readerZhResourceOriginal', { value: current });
  globalThis.readerLookupChineseWord = wrapped;
  state.lookupBridgeInstalled = true;
  return true;
}

function installBridgeEventually() {
  if (installLookupBridge()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (installLookupBridge() || attempts >= 100) clearInterval(timer);
  }, 100);
}

async function loadManifest() {
  if (state.manifest || state.manifestPromise) return state.manifestPromise || state.manifest;
  state.manifestPromise = fetch(new URL(MANIFEST_URL, location.origin), { cache: 'force-cache' })
    .then((response) => response.ok ? response.json() : null)
    .then((manifest) => {
      state.manifest = manifest;
      return manifest;
    })
    .catch(() => null)
    .finally(() => { state.manifestPromise = null; });
  return state.manifestPromise;
}

async function load() {
  nativeBridge();
  installLookupBridge();
  await loadManifest();
  return state;
}

globalThis.readerChineseResourceMeta = metaForWord;
globalThis.readerLookupChineseResource = (word) => resourceLookup(word, { queue: true });
globalThis.readerEnsureChineseResources = load;
globalThis.readerChineseResourceStats = () => ({
  nativeAvailable: state.nativeAvailable,
  cacheSize: state.cache.size,
  missCount: state.misses.size,
  queued: state.queued.size,
  pending: state.pending.size,
  received: state.received,
  error: state.error,
  manifest: state.manifest,
});

installBridgeEventually();
load();

export { load, metaForWord, resourceLookup, mergeLookup };

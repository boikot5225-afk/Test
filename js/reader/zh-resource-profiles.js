// Supplemental Chinese language resources for Reader AI.
// Generated at build time from Migaku's public resource index.
//
// Contract:
// - NEVER changes pagination, word DOM, Known/Unknown thresholds or the 39,999-word
//   assessment scale by itself;
// - adds BLCU / SUBTLEX-CH / Jieba / HSK metadata;
// - adds Mandarin dictionary entries only as a fallback when Reader's own lookup
//   has no pinyin/English definition;
// - fails closed: a missing/corrupt optional asset leaves toc94 behavior intact.

const PROFILE_URL = 'data/zh_migaku_profiles.json';
const DICT_URL = 'data/zh_migaku_dict.json';
const MANIFEST_URL = 'data/zh_migaku_manifest.json';
const STATE_KEY = '__readerZhResourceLayerV1';

const state = globalThis[STATE_KEY] || {
  loading: null,
  ready: false,
  profiles: new Map(),
  dictionary: new Map(),
  manifest: null,
  error: '',
  lookupBridgeInstalled: false,
};
globalThis[STATE_KEY] = state;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeWord(value) {
  return clean(value);
}

async function fetchJson(path) {
  const response = await fetch(new URL(path, document.baseURI), { cache: 'force-cache' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function buildProfiles(payload) {
  const map = new Map();
  for (const row of Array.isArray(payload?.entries) ? payload.entries : []) {
    const word = normalizeWord(row?.w || row?.word);
    if (!word) continue;
    map.set(word, Object.freeze({
      word,
      blcuRank: Number.isFinite(Number(row?.b)) ? Number(row.b) : null,
      subtlexRank: Number.isFinite(Number(row?.s)) ? Number(row.s) : null,
      jiebaRank: Number.isFinite(Number(row?.j)) ? Number(row.j) : null,
      hsk: clean(row?.h),
      newHsk: clean(row?.n),
    }));
  }
  return map;
}

function buildDictionary(payload) {
  const map = new Map();
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : [];
  for (const row of entries) {
    const word = normalizeWord(row?.word || row?.term);
    if (!word) continue;
    const entry = {
      word,
      pinyin: clean(row?.pinyin || row?.reading),
      en: clean(row?.en || row?.definition),
      alt: clean(row?.alt || row?.termAlt),
      tags: clean(row?.tags || row?.vocabularyTags),
      _source: 'migaku_resource',
      _note: 'дополнительный локальный словарь Migaku',
    };
    map.set(word, Object.freeze(entry));
    if (entry.alt && !map.has(entry.alt)) {
      map.set(entry.alt, Object.freeze({ ...entry, word: entry.alt, alt: word }));
    }
  }
  return map;
}

function metaForWord(word) {
  return state.profiles.get(normalizeWord(word)) || null;
}

function resourceLookup(word) {
  const normalized = normalizeWord(word);
  if (!normalized) return null;
  const dict = state.dictionary.get(normalized) || null;
  const meta = state.profiles.get(normalized) || null;
  if (!dict && !meta) return null;
  return {
    ...(dict || { word: normalized, pinyin: '', en: '', _source: 'migaku_resource_meta' }),
    frequency: meta || null,
    blcuRank: meta?.blcuRank ?? null,
    subtlexRank: meta?.subtlexRank ?? null,
    jiebaRank: meta?.jiebaRank ?? null,
    hsk: meta?.hsk || '',
    newHsk: meta?.newHsk || '',
  };
}

function mergeLookup(primary, extra, originalWord) {
  if (!primary && !extra) return null;
  const base = primary && typeof primary === 'object' ? primary : {};
  const fallback = extra && typeof extra === 'object' ? extra : {};
  const merged = {
    ...fallback,
    ...base,
    word: clean(base.word || fallback.word || originalWord),
    surface: base.surface || originalWord,
    lemma: base.lemma || fallback.word || clean(originalWord),
    pinyin: clean(base.pinyin || base.py || fallback.pinyin),
    en: clean(base.en || base.english || base.definition || fallback.en),
    ru: clean(base.ru || base.translation_ru || base.russian),
    frequency: fallback.frequency || base.frequency || null,
    blcuRank: fallback.blcuRank ?? base.blcuRank ?? null,
    subtlexRank: fallback.subtlexRank ?? base.subtlexRank ?? null,
    jiebaRank: fallback.jiebaRank ?? base.jiebaRank ?? null,
    hsk: clean(base.hsk || base.level || fallback.hsk),
    newHsk: clean(base.newHsk || fallback.newHsk),
  };
  if (primary) {
    merged._source = base._source || 'reader_core';
    merged._note = base._note || 'локальный китайский словарь';
    if (extra) merged._resourceSupplement = 'migaku';
  }
  return merged;
}

function installLookupBridge() {
  if (state.lookupBridgeInstalled) return true;
  const current = globalThis.readerLookupChineseWord;
  if (typeof current !== 'function') return false;
  if (current.__readerZhResourceBridgeV1) {
    state.lookupBridgeInstalled = true;
    return true;
  }

  const wrapped = function readerLookupChineseWordWithResources(word) {
    let primary = null;
    try { primary = current(word) || null; } catch {}
    const extra = resourceLookup(word);
    return mergeLookup(primary, extra, word);
  };
  Object.defineProperty(wrapped, '__readerZhResourceBridgeV1', { value: true });
  Object.defineProperty(wrapped, '__readerZhResourceOriginal', { value: current });
  globalThis.readerLookupChineseWord = wrapped;
  state.lookupBridgeInstalled = true;
  return true;
}

function emitReady() {
  try {
    window.dispatchEvent(new CustomEvent('reader:zh-resource-ready', {
      detail: {
        dictionaryCount: state.dictionary.size,
        profileCount: state.profiles.size,
        manifest: state.manifest,
      },
    }));
    window.dispatchEvent(new CustomEvent('reader:zh-core-ready'));
  } catch {}
}

async function load() {
  if (state.ready) return state;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const [profiles, dictionary, manifest] = await Promise.all([
        fetchJson(PROFILE_URL),
        fetchJson(DICT_URL),
        fetchJson(MANIFEST_URL).catch(() => null),
      ]);
      state.profiles = buildProfiles(profiles);
      state.dictionary = buildDictionary(dictionary);
      state.manifest = manifest;
      state.ready = true;
      state.error = '';
      installLookupBridge();
      emitReady();
      return state;
    } catch (error) {
      state.error = String(error?.message || error || 'resource load failed');
      console.warn('[zh resources] optional Migaku layer unavailable:', state.error);
      return state;
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

function installBridgeEventually() {
  if (installLookupBridge()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (installLookupBridge() || attempts >= 80) clearInterval(timer);
  }, 100);
}

globalThis.readerChineseResourceMeta = metaForWord;
globalThis.readerLookupChineseResource = resourceLookup;
globalThis.readerEnsureChineseResources = load;
globalThis.readerChineseResourceStats = () => ({
  ready: state.ready,
  dictionaryCount: state.dictionary.size,
  profileCount: state.profiles.size,
  error: state.error,
  manifest: state.manifest,
});

installBridgeEventually();
load();

export { load, metaForWord, resourceLookup, mergeLookup };

// toc132 — conservative paragraph-level English contextual refinement.
// Existing Migaku Known/Unknown, morphology and immediate WikDict glosses stay
// authoritative for first paint. This module owns no Reader layout/navigation:
// it batches already-rendered Unknown occurrences by paragraph and only replaces
// an existing gloss after a high-confidence contextual answer.

const SENSES_URL = new URL('../../../wikdict/en_ru_senses.json?v=2', import.meta.url).href;
const CACHE_KEY_BASE = 'an2_reader_en_context_batch_v2';
const MAX_CACHE = 5200;
const MAX_TARGETS = 24;
const MAX_VISIBLE_PARAGRAPHS = 4;
const MAX_ACTIVE = 1;
const MIN_CONFIDENCE = 0.84;
const CALL_TIMEOUT_MS = 55_000;
const RETRY_MS = 12_000;

const state = globalThis.__readerEnContextBatchV2 || {
  cache: null,
  senses: null,
  sensesPromise: null,
  inFlight: new Set(),
  active: 0,
  timer: 0,
  retryTimer: 0,
};
globalThis.__readerEnContextBatchV2 = state;

function normalize(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hasCyrillic(value) {
  return /[\u0400-\u052f]/u.test(String(value || ''));
}

function cleanRu(value, max = 48) {
  const text = clean(value, max + 24)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?…]+$/g, '')
    .trim();
  if (!text || !hasCyrillic(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return '';
  return text.slice(0, max).trim();
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'english' || raw === 'en' || raw.startsWith('en-') ? 'en' : raw;
}

function storageKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function hashText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function loadCache() {
  if (state.cache instanceof Map) return state.cache;
  const map = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(CACHE_KEY_BASE)) || '{}');
    for (const [key, value] of Object.entries(raw || {})) {
      const ru = cleanRu(value?.ru);
      const confidence = Number(value?.confidence || 0);
      if (key && ru && confidence >= MIN_CONFIDENCE) map.set(key, { ...value, ru, confidence });
    }
  } catch {}
  state.cache = map;
  return map;
}

function saveCache() {
  const cache = loadCache();
  if (cache.size > MAX_CACHE) {
    const ordered = Array.from(cache.entries())
      .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
      .slice(0, MAX_CACHE);
    cache.clear();
    ordered.forEach(([key, value]) => cache.set(key, value));
  }
  try { localStorage.setItem(storageKey(CACHE_KEY_BASE), JSON.stringify(Object.fromEntries(cache))); } catch {}
}

async function loadSenses() {
  if (state.senses) return state.senses;
  if (state.sensesPromise) return state.sensesPromise;
  state.sensesPromise = fetch(SENSES_URL, { cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`EN senses HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      state.senses = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      return state.senses;
    })
    .catch(error => {
      console.warn('[en context batch] sense hints unavailable', error?.message || error);
      return {};
    })
    .finally(() => { state.sensesPromise = null; });
  return state.sensesPromise;
}

function surface(el) {
  return clean(el?.dataset?.word || el?.textContent || '', 48);
}

function lemmaFor(surfaceValue) {
  const raw = normalize(surfaceValue);
  try { return normalize(globalThis.readerEnglishLemmaFor?.(raw) || raw); }
  catch { return raw; }
}

function glossPair(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
  const node = wrap?.querySelector?.(':scope > .rw-en-gloss-text') || null;
  return { wrap, node };
}

function currentLocalRu(el) {
  const { node } = glossPair(el);
  return cleanRu(node?.textContent || '');
}

function setGloss(el, ru, key) {
  if (!el?.isConnected || !el.classList.contains('rw-migaku-unknown')) return false;
  const value = cleanRu(ru);
  if (!value) return false;
  const { wrap, node } = glossPair(el);
  if (!wrap || !node) return false;
  const same = String(node.textContent || '').trim() === value
    && wrap.dataset.enContextProvider === 'deepseek-context'
    && wrap.dataset.enContextKey === key;
  if (same) return false;
  node.textContent = value;
  wrap.dataset.enGlossRu = value;
  // Existing English dictionary/ML Kit/rule layers already treat this exact
  // provider as final priority, so a successful batch answer cannot be painted
  // over later by a lower-confidence fallback.
  wrap.dataset.enContextProvider = 'deepseek-context';
  wrap.dataset.enContextKey = key || '';
  wrap.dataset.enContextBatch = 'v2';
  return true;
}

function paragraphContext(paragraph) {
  if (!paragraph) return '';
  try {
    const clone = paragraph.cloneNode(true);
    clone.querySelectorAll('.rw-en-gloss-text,[aria-hidden="true"]').forEach(node => node.remove());
    const text = clean(clone.textContent || '', 1800);
    if (text) return text;
  } catch {}
  return clean(Array.from(paragraph.querySelectorAll('.reader-word[data-word]')).map(surface).join(' '), 1800);
}

function visibleParagraphs() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const page = root.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');
  const scope = page || root;
  const all = Array.from(scope.querySelectorAll('.reader-paragraph'));
  if (!all.length) return [];
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  const visible = all.filter(paragraph => {
    try {
      const rect = paragraph.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= -80 && rect.top <= viewportHeight + 80;
    } catch { return false; }
  });
  return (visible.length ? visible : all).slice(0, MAX_VISIBLE_PARAGRAPHS);
}

function candidateSenses(dict, surfaceValue, lemmaValue) {
  const out = [];
  const seen = new Set();
  for (const key of [normalize(surfaceValue), normalize(lemmaValue)]) {
    for (const raw of Array.isArray(dict?.[key]) ? dict[key] : []) {
      const ru = cleanRu(raw);
      const folded = ru.toLocaleLowerCase('ru-RU');
      if (!ru || seen.has(folded)) continue;
      seen.add(folded);
      out.push(ru);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function occurrenceKey(paragraph, context, tokenIndex, surfaceValue) {
  const root = document.getElementById('reader-chapter-text');
  return [
    root?.dataset?.readerBookId || 'book',
    root?.dataset?.renderedChapter || '0',
    paragraph?.dataset?.p || '0',
    hashText(normalize(context)),
    tokenIndex,
    normalize(surfaceValue),
  ].join('|');
}

function paragraphTargets(paragraph, context, dict) {
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const out = [];
  words.forEach((el, tokenIndex) => {
    if (!el.classList.contains('rw-migaku-unknown')) return;
    const { wrap, node } = glossPair(el);
    if (!wrap || !node) return;
    const raw = surface(el);
    if (!raw) return;
    const lemma = lemmaFor(raw);
    out.push({
      id: `t${tokenIndex}`,
      el,
      key: occurrenceKey(paragraph, context, tokenIndex, raw),
      surface: raw,
      lemma,
      localRu: currentLocalRu(el),
      senses: candidateSenses(dict, raw, lemma),
    });
  });
  return out.slice(0, MAX_TARGETS);
}

function firebaseFunctionsClient() {
  for (const candidate of [globalThis.firebase, globalThis.__AN2_FALLBACK_FIREBASE].filter(Boolean)) {
    try {
      const app = typeof candidate.app === 'function' ? candidate.app() : null;
      if (typeof app?.functions === 'function') return candidate;
    } catch {}
  }
  return null;
}

function functionRegion() {
  return clean(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1', 40) || 'asia-southeast1';
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readerAI en_context_batch timeout')), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function callBatch(context, targets) {
  const firebase = firebaseFunctionsClient();
  if (!firebase?.app) throw new Error('Firebase Functions not ready');
  const fn = firebase.app().functions(functionRegion()).httpsCallable('readerAI');
  const payloadTargets = targets.map(item => ({
    id: item.id,
    surface: item.surface,
    lemma: item.lemma,
    localRu: item.localRu,
    senses: item.senses,
  }));
  const result = await withTimeout(fn({
    task: 'en_context_batch',
    sourceLang: 'en',
    context,
    targets: payloadTargets,
  }), CALL_TIMEOUT_MS);
  const payload = result?.data?.data || result?.data || {};
  return Array.isArray(payload?.items) ? payload.items : [];
}

function applyCached(targets) {
  const cache = loadCache();
  let applied = 0;
  for (const target of targets) {
    const cached = cache.get(target.key);
    if (!cached?.ru || Number(cached.confidence || 0) < MIN_CONFIDENCE) continue;
    if (setGloss(target.el, cached.ru, target.key)) applied += 1;
  }
  return applied;
}

function cacheResult(target, result) {
  const ru = cleanRu(result?.ru);
  const confidence = Math.max(0, Math.min(1, Number(result?.confidence || 0)));
  const pos = clean(result?.pos, 24).toLowerCase();
  if (pos === 'proper_noun' || !ru || confidence < MIN_CONFIDENCE) return false;
  const cache = loadCache();
  cache.set(target.key, {
    ru,
    lemma: clean(result?.lemma || target.lemma, 48),
    pos,
    confidence,
    note: clean(result?.note, 90),
    ts: Date.now(),
  });
  setGloss(target.el, ru, target.key);
  return true;
}

async function refineParagraph(paragraph, dict) {
  const context = paragraphContext(paragraph);
  if (!context) return;
  const paragraphKey = `${paragraph?.dataset?.p || '0'}:${hashText(normalize(context))}`;
  const targets = paragraphTargets(paragraph, context, dict);
  if (!targets.length) return;

  applyCached(targets);
  const cache = loadCache();
  const missing = targets.filter(target => !cache.has(target.key));
  if (!missing.length || state.inFlight.has(paragraphKey) || state.active >= MAX_ACTIVE) return;
  if (!firebaseFunctionsClient()) {
    scheduleRetry();
    return;
  }

  state.inFlight.add(paragraphKey);
  state.active += 1;
  try {
    const items = await callBatch(context, missing);
    const byId = new Map(items.map(item => [clean(item?.id, 40), item]));
    let changed = false;
    for (const target of missing) {
      const result = byId.get(target.id);
      if (!result) continue;
      if (cacheResult(target, result)) changed = true;
    }
    if (changed) saveCache();
  } catch (error) {
    console.warn('[en context batch] request failed', error?.code || error?.message || error);
    scheduleRetry();
  } finally {
    state.inFlight.delete(paragraphKey);
    state.active = Math.max(0, state.active - 1);
    schedule('next-paragraph', 40);
  }
}

async function refine(reason = 'event') {
  if (currentLang() !== 'en') return;
  const paragraphs = visibleParagraphs();
  if (!paragraphs.length) return;
  const dict = await loadSenses();
  for (const paragraph of paragraphs) {
    if (state.active >= MAX_ACTIVE) break;
    void refineParagraph(paragraph, dict);
  }
}

function schedule(reason = 'event', delay = 180) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { void refine(reason); }, Math.max(0, delay));
}

function kick(reason) {
  schedule(reason, 80);
  setTimeout(() => schedule(`${reason}-settled`, 0), 320);
  setTimeout(() => schedule(`${reason}-late`, 0), 900);
}

function scheduleRetry() {
  if (state.retryTimer) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = 0;
    schedule('retry', 0);
  }, RETRY_MS);
}

if (typeof window !== 'undefined' && !window.__readerEnContextBatchV2Bound) {
  window.__readerEnContextBatchV2Bound = true;
  window.addEventListener('reader:pagechange', () => kick('pagechange'));
  window.addEventListener('reader:en-vocab-ready', () => kick('vocab-ready'));
  window.addEventListener('reader:en-morphology-augmented', () => kick('morphology'));
  window.addEventListener('reader:word-state-changed', () => kick('word-state'));
  window.addEventListener('pageshow', () => kick('pageshow'));
  kick('module-load');
}

export {
  MIN_CONFIDENCE,
  normalize,
  cleanRu,
  paragraphContext,
  occurrenceKey,
  cacheResult,
  refine,
  firebaseFunctionsClient,
};

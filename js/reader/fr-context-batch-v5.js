// toc125 — paragraph-level French contextual refinement, guest-safe.
// The primary French pipeline paints an immediate local gloss. This module
// never owns layout/pagination and never paints a loading placeholder. It sends
// all Unknown occurrences from one paragraph in one DeepSeek batch and only
// replaces existing gloss text after a contextual answer arrives.

const SENSES_URL = new URL('../../../frreader/fr_ru_senses.json?v=5', import.meta.url).href;
const CACHE_KEY_BASE = 'an2_reader_fr_context_batch_v5';
const MAX_CACHE = 5200;
const MAX_TARGETS = 24;
const MAX_VISIBLE_PARAGRAPHS = 4;
const MAX_ACTIVE = 1;
const CALL_TIMEOUT_MS = 55_000;
const RETRY_MS = 12_000;

const state = globalThis.__readerFrContextBatchV5 || {
  cache: null,
  senses: null,
  sensesPromise: null,
  inFlight: new Set(),
  active: 0,
  timer: 0,
  retryTimer: 0,
};
globalThis.__readerFrContextBatchV5 = state;

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr-FR');
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hasCyrillic(value) {
  return /[\u0400-\u052f]/u.test(String(value || ''));
}

function cleanRu(value, max = 48) {
  let text = clean(value, max + 24)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?…]+$/g, '')
    .trim();
  try {
    const shared = globalThis.readerFrenchSanitizeRussian?.(text, max);
    if (shared) text = shared;
  } catch {}
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
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
}

function storageKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
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
    const raw = JSON.parse(localStorage.getItem(storageKey(CACHE_KEY_BASE)) || '{}');
    for (const [key, value] of Object.entries(raw || {})) {
      const ru = cleanRu(value?.ru);
      if (key && ru) map.set(key, { ...value, ru });
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
    .then(r => {
      if (!r.ok) throw new Error(`FR senses HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      state.senses = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      return state.senses;
    })
    .catch(() => ({}))
    .finally(() => { state.sensesPromise = null; });
  return state.sensesPromise;
}

function surface(el) {
  return clean(el?.dataset?.word || el?.textContent || '', 48);
}

function lemmaFor(surfaceValue) {
  const raw = normalize(surfaceValue);
  try {
    const contextual = globalThis.readerFrenchLexicalOverrideLemmaFor?.(raw);
    if (contextual) return normalize(contextual);
    return normalize(globalThis.readerFrenchLemmaFor?.(raw) || raw);
  } catch { return raw; }
}

function glossPair(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-fr-v2-wrap') ? el.parentElement : null;
  const node = wrap?.querySelector?.(':scope > .rw-fr-v2-gloss') || null;
  return { wrap, node };
}

function currentLocalRu(el) {
  const { node } = glossPair(el);
  const text = clean(node?.textContent || '', 48);
  if (!text || /^перевод…?$/iu.test(text)) return '';
  return cleanRu(text);
}

function setGloss(el, ru, provider, key) {
  if (!el?.isConnected || !el.classList.contains('rw-migaku-unknown')) return false;
  const value = cleanRu(ru);
  if (!value) return false;
  const { wrap, node } = glossPair(el);
  if (!wrap || !node) return false;
  if (node.textContent === value && wrap.dataset.frProvider === provider) return false;
  node.textContent = value;
  wrap.dataset.frProvider = provider;
  wrap.dataset.frContextKey = key || '';
  delete wrap.dataset.frContextPending;
  return true;
}

function paragraphContext(paragraph) {
  if (!paragraph) return '';
  try {
    const clone = paragraph.cloneNode(true);
    clone.querySelectorAll('.rw-fr-v2-gloss,[aria-hidden="true"]').forEach(node => node.remove());
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
      const ru = cleanRu(raw, 48);
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
    if (/^перевод…?$/iu.test(clean(node.textContent || '', 48))) node.textContent = '';
    const raw = surface(el);
    if (!raw) return;
    const lemma = lemmaFor(raw);
    const key = occurrenceKey(paragraph, context, tokenIndex, raw);
    out.push({
      id: `t${tokenIndex}`,
      el,
      key,
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
    const timer = setTimeout(() => reject(new Error('readerAI fr_context_batch timeout')), ms);
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
    task: 'fr_context_batch',
    sourceLang: 'fr',
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
    if (!cached?.ru) continue;
    if (setGloss(target.el, cached.ru, 'context-batch-cache', target.key)) applied += 1;
  }
  return applied;
}

function cacheResult(target, result) {
  const ru = cleanRu(result?.ru);
  const confidence = Math.max(0, Math.min(1, Number(result?.confidence || 0)));
  if (!ru || confidence < 0.50) return false;
  const cache = loadCache();
  cache.set(target.key, {
    ru,
    lemma: clean(result?.lemma || target.lemma, 48),
    pos: clean(result?.pos, 24),
    confidence,
    note: clean(result?.note, 90),
    ts: Date.now(),
  });
  setGloss(target.el, ru, 'context-deepseek-batch', target.key);
  return true;
}

async function refineParagraph(paragraph, dict) {
  const context = paragraphContext(paragraph);
  if (!context) return;
  const contextHash = hashText(normalize(context));
  const paragraphKey = `${paragraph?.dataset?.p || '0'}:${contextHash}`;
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
      if (clean(result?.pos, 24).toLowerCase() === 'proper_noun') continue;
      if (cacheResult(target, result)) changed = true;
    }
    if (changed) saveCache();
  } catch (error) {
    console.warn('[fr context batch] request failed', error?.code || error?.message || error);
    scheduleRetry();
  } finally {
    state.inFlight.delete(paragraphKey);
    state.active = Math.max(0, state.active - 1);
    schedule('next-paragraph', 40);
  }
}

async function refine(reason = 'event') {
  if (currentLang() !== 'fr') return;
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

function scheduleRetry() {
  if (state.retryTimer) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = 0;
    schedule('retry', 0);
  }, RETRY_MS);
}

if (typeof window !== 'undefined' && !window.__readerFrContextBatchV5Bound) {
  window.__readerFrContextBatchV5Bound = true;
  window.addEventListener('reader:fr-pipeline-v2-ready', () => schedule('pipeline-ready', 220));
  window.addEventListener('reader:pagechange', () => schedule('pagechange', 120));
  window.addEventListener('reader:fr-lexical-corrected', () => schedule('lexical-corrected', 160));
  window.addEventListener('reader:word-state-changed', () => schedule('word-state', 120));
  window.addEventListener('pageshow', () => schedule('pageshow', 180));
}

export { normalize, cleanRu, paragraphContext, refine, firebaseFunctionsClient };

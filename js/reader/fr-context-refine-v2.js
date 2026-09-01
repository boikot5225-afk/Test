// toc124 — event-driven French inline quality refinement.
//
// The primary French pipeline owns layout and paints an immediate local gloss.
// This file never wraps words and never observes DOM mutations. It only edits
// the already-existing .rw-fr-v2-gloss text after reader:fr-pipeline-v2-ready.
// Fast local corrections run first; optional ML Kit context runs in background.

const SENSES_URL = new URL('../../../frreader/fr_ru_senses.json?v=2', import.meta.url).href;
const CACHE_KEY_BASE = 'an2_reader_fr_occurrence_refine_v2';
const MAX_CACHE = 3200;
const MAX_ACTIVE = 2;
const MAX_CONTEXT_REQUESTS_PER_PASS = 10;
const MARK_L = '⟦';
const MARK_R = '⟧';

let senses = null;
let sensesPromise = null;
let seq = 0;
let active = 0;
let scheduled = 0;
let passRunning = false;
let rerun = false;
const pending = new Map();
const queuedKeys = new Set();

const SAFE_SURFACE = new Map([
  ['mec', 'парень'],
  ['joli', 'милый'],
  ["qu'il", 'что'],
  ["qu'elle", 'что'],
  ["qu'on", 'что'],
  ["c'est", 'это'],
  ["j'ai", 'у меня'],
  ["n'est", 'не'],
]);

const PHRASES = [
  { words: ['à', 'présent'], values: { 1: 'сейчас' }, id: 'a-present' },
  { words: ['sans', 'arrêt'], values: { 1: 'постоянно' }, id: 'sans-arret' },
  { words: ['sentir', 'mauvais'], values: { 0: 'пахнуть', 1: 'плохо' }, id: 'sentir-mauvais' },
  { words: ['chair', 'de', 'poule'], values: { 0: 'мурашки' }, id: 'chair-de-poule' },
];

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('fr-FR');
}

function hasCyrillic(value) {
  return /[\u0400-\u052f]/u.test(String(value || ''));
}

function cleanRu(value, max = 42) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  try {
    const shared = globalThis.readerFrenchSanitizeRussian?.(text, max);
    if (shared) text = shared;
  } catch {}
  if (!text || !hasCyrillic(text)) return '';
  text = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\[[^\]]*$/g, '')
    .replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '')
    .trim();
  if (!text) return '';
  const first = text.split(/\s*[;；|/]\s*/).filter(Boolean)[0] || text;
  if (first.length <= max) return first;
  const cut = first.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(max * .55) ? cut.slice(0, space) : first.slice(0, max)).trim();
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

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(CACHE_KEY_BASE)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function saveCache(cache) {
  try {
    let entries = Object.entries(cache || {});
    if (entries.length > MAX_CACHE) {
      entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
      entries = entries.slice(0, MAX_CACHE);
    }
    localStorage.setItem(storageKey(CACHE_KEY_BASE), JSON.stringify(Object.fromEntries(entries)));
  } catch {}
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

async function loadSenses() {
  if (senses) return senses;
  if (sensesPromise) return sensesPromise;
  sensesPromise = fetch(SENSES_URL, { cache: 'force-cache' })
    .then(r => {
      if (!r.ok) throw new Error(`FR senses HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      senses = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      return senses;
    })
    .finally(() => { sensesPromise = null; });
  return sensesPromise;
}

function surface(el) {
  return String(el?.dataset?.word || el?.textContent || '').trim();
}

function lemma(surfaceValue) {
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

function setGloss(el, ru, provider, key = '') {
  if (!el?.isConnected || !el.classList.contains('rw-migaku-unknown')) return false;
  const value = cleanRu(ru);
  if (!value) return false;
  const { wrap, node } = glossPair(el);
  if (!wrap || !node) return false;
  if (node.textContent === value && wrap.dataset.frProvider === provider) return false;
  node.textContent = value;
  wrap.dataset.frProvider = provider;
  if (key) wrap.dataset.frRefineKey = key;
  return true;
}

function setPending(el, key) {
  const { wrap, node } = glossPair(el);
  if (!wrap || !node || String(node.textContent || '').trim()) return;
  node.textContent = 'перевод…';
  wrap.dataset.frProvider = 'context-pending';
  if (key) wrap.dataset.frRefineKey = key;
}

function paragraphWords(paragraph) {
  return Array.from(paragraph?.querySelectorAll?.('.reader-word[data-word]') || []);
}

function sourceContext(paragraph) {
  return paragraphWords(paragraph).map(surface).filter(Boolean).join(' ');
}

function occurrenceKey(el, paragraph) {
  const root = document.getElementById('reader-chapter-text');
  const words = paragraphWords(paragraph);
  const index = Math.max(0, words.indexOf(el));
  const context = sourceContext(paragraph);
  return [
    root?.dataset?.readerBookId || 'book',
    root?.dataset?.renderedChapter || '0',
    paragraph?.dataset?.p || '0',
    index,
    hashText(normalize(context)),
  ].join('|');
}

function phraseOverrides(paragraph) {
  const words = paragraphWords(paragraph);
  const values = words.map(el => normalize(surface(el)));
  const lemmas = words.map(el => lemma(surface(el)));
  const out = new Map();
  for (let start = 0; start < words.length; start += 1) {
    for (const rule of PHRASES) {
      if (start + rule.words.length > words.length) continue;
      let ok = true;
      for (let i = 0; i < rule.words.length; i += 1) {
        if (values[start + i] !== rule.words[i] && lemmas[start + i] !== rule.words[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const [offsetRaw, ru] of Object.entries(rule.values)) {
        const target = words[start + Number(offsetRaw)];
        if (target) out.set(target, { ru, provider: `quality:${rule.id}` });
      }
    }
  }
  return out;
}

function candidateSenses(dict, surfaceValue, lemmaValue) {
  const out = [];
  const seen = new Set();
  for (const key of [normalize(surfaceValue), normalize(lemmaValue)]) {
    for (const raw of Array.isArray(dict?.[key]) ? dict[key] : []) {
      const ru = cleanRu(raw, 64);
      const folded = ru.toLocaleLowerCase('ru-RU');
      if (!ru || seen.has(folded)) continue;
      seen.add(folded);
      out.push(ru);
    }
  }
  return out.slice(0, 16);
}

async function localFallback(el, dict, phrase) {
  const raw = surface(el);
  const norm = normalize(raw);
  const lem = lemma(raw);
  const key = occurrenceKey(el, el.closest('.reader-paragraph'));

  const safe = SAFE_SURFACE.get(norm);
  if (safe) {
    setGloss(el, safe, 'quality:safe-surface', key);
    return { resolved: true, candidates: candidateSenses(dict, raw, lem), key, protected: true };
  }
  if (phrase?.ru) {
    setGloss(el, phrase.ru, phrase.provider || 'quality:phrase', key);
    return { resolved: true, candidates: candidateSenses(dict, raw, lem), key, protected: true };
  }

  const pair = glossPair(el);
  let existing = cleanRu(pair.node?.textContent || '');
  const candidates = candidateSenses(dict, raw, lem);

  // Ask the lexical owner only for locally-computable morphology/context. This
  // is still offline and normally resolves forms such as fumant -> fumer.
  if (!existing && typeof globalThis.readerFrenchContextualAnalysisFor === 'function') {
    try {
      const context = sourceContext(el.closest('.reader-paragraph'));
      const analysis = await globalThis.readerFrenchContextualAnalysisFor(raw, context);
      const ru = cleanRu(analysis?.ru || analysis?.meaning || '');
      if (ru) {
        setGloss(el, ru, 'quality:local-morphology', key);
        existing = ru;
      }
    } catch {}
  }

  if (!existing && candidates.length) {
    setGloss(el, candidates[0], 'quality:senses-fallback', key);
    existing = candidates[0];
  }

  return { resolved: !!existing, candidates, key, protected: false };
}

function visibleScope(root) {
  const page = root.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');
  return page || root;
}

function contextModel(el, radius = 7) {
  const paragraph = el.closest('.reader-paragraph');
  const words = paragraphWords(paragraph);
  const absolute = words.indexOf(el);
  if (absolute < 0) {
    const s = surface(el);
    return { source: s, marked: `${MARK_L}${s}${MARK_R}`, context: s, prev: '' };
  }
  const start = Math.max(0, absolute - radius);
  const end = Math.min(words.length, absolute + radius + 1);
  const slice = words.slice(start, end).map(surface);
  const index = absolute - start;
  const source = slice[index] || surface(el);
  const marked = slice.slice();
  marked[index] = `${MARK_L}${source}${MARK_R}`;
  return {
    source,
    marked: marked.join(' '),
    context: slice.join(' '),
    prev: index > 0 ? normalize(slice[index - 1]) : '',
  };
}

function extractMarked(translated) {
  const text = String(translated || '');
  const match = text.match(/[⟦【]\s*([^⟧】]{1,80}?)\s*[⟧】]/u);
  return cleanRu(match?.[1] || '', 48);
}

function ruTokens(value) {
  return String(value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^а-я\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function chooseCandidate(candidates, translated) {
  const translatedTokens = ruTokens(translated);
  let best = null;
  for (const candidate of candidates || []) {
    for (const ct of ruTokens(candidate)) {
      for (const tt of translatedTokens) {
        let score = 0;
        if (ct === tt) score = 10;
        else if (ct.length >= 4 && tt.length >= 4 && ct.slice(0, 4) === tt.slice(0, 4)) score = 6;
        else if (ct.length >= 5 && tt.length >= 5 && (ct.startsWith(tt.slice(0, 4)) || tt.startsWith(ct.slice(0, 4)))) score = 4;
        if (score && (!best || score > best.score)) best = { score, value: candidate };
      }
    }
  }
  return best?.score >= 4 ? cleanRu(best.value) : '';
}

function requestContext(el, candidates, key) {
  const bridge = globalThis.ReaderFrenchContextTranslate;
  if (!bridge || typeof bridge.translate !== 'function') return false;
  if (active >= MAX_ACTIVE || queuedKeys.has(key)) return false;
  const model = contextModel(el);
  const requestId = `frq-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  pending.set(requestId, { el, key, candidates, model });
  queuedKeys.add(key);
  active += 1;
  try {
    bridge.translate(requestId, model.marked);
    return true;
  } catch {
    pending.delete(requestId);
    queuedKeys.delete(key);
    active = Math.max(0, active - 1);
    return false;
  }
}

function parsePayload(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

if (typeof window !== 'undefined') {
  window.__readerFrContextTranslateResolve = (requestId, ok, payloadRaw) => {
    const item = pending.get(String(requestId || ''));
    if (!item) return;
    pending.delete(String(requestId || ''));
    queuedKeys.delete(item.key);
    active = Math.max(0, active - 1);
    const payload = parsePayload(payloadRaw);
    if (ok) {
      const translated = String(payload.translated || '');
      const ru = extractMarked(translated) || chooseCandidate(item.candidates, translated);
      if (ru && item.el?.isConnected) {
        setGloss(item.el, ru, 'quality:mlkit-context', item.key);
        const cache = readCache();
        cache[item.key] = { ru, t: Date.now(), provider: 'quality:mlkit-context' };
        saveCache(cache);
      }
    }
    schedule('context-drain', 20);
  };
}

async function refine(reason = 'event') {
  if (currentLang() !== 'fr') return;
  if (passRunning) { rerun = true; return; }
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  passRunning = true;
  try {
    const dict = await loadSenses();
    const cache = readCache();
    const allParagraphs = Array.from(root.querySelectorAll('.reader-paragraph'));
    for (const paragraph of allParagraphs) {
      const phraseMap = phraseOverrides(paragraph);
      for (const el of paragraphWords(paragraph)) {
        if (!el.classList.contains('rw-migaku-unknown')) continue;
        const key = occurrenceKey(el, paragraph);
        const cached = cleanRu(cache[key]?.ru || '');
        if (cached) {
          setGloss(el, cached, cache[key]?.provider || 'quality:cache', key);
          continue;
        }
        await localFallback(el, dict, phraseMap.get(el));
      }
    }

    // Context inference is deliberately limited to the visible page and starts
    // only after every Unknown has a local value. It therefore cannot cause the
    // old first-paint stalls even when the French ML Kit model is not installed.
    const scope = visibleScope(root);
    let requested = 0;
    for (const el of scope.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')) {
      if (requested >= MAX_CONTEXT_REQUESTS_PER_PASS || active >= MAX_ACTIVE) break;
      const pair = glossPair(el);
      if (!pair.wrap || !pair.node) continue;
      const provider = String(pair.wrap.dataset.frProvider || '');
      if (provider.startsWith('quality:phrase') || provider === 'quality:safe-surface' || provider === 'surface-context' || provider.startsWith('phrase:')) continue;
      const raw = surface(el);
      const candidates = candidateSenses(dict, raw, lemma(raw));
      const existing = cleanRu(pair.node.textContent || '');
      const ambiguous = candidates.length >= 2;
      if (!existing) setPending(el, occurrenceKey(el, el.closest('.reader-paragraph')));
      if (!ambiguous && existing) continue;
      const key = occurrenceKey(el, el.closest('.reader-paragraph'));
      if (requestContext(el, candidates, key)) requested += 1;
    }

    try {
      window.dispatchEvent(new CustomEvent('reader:fr-quality-ready', { detail: { reason } }));
    } catch {}
  } finally {
    passRunning = false;
    if (rerun) { rerun = false; schedule('rerun', 0); }
  }
}

function schedule(reason = 'event', delay = 45) {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => { void refine(reason); }, Math.max(0, Number(delay) || 0));
}

if (typeof window !== 'undefined' && !window.__readerFrContextRefineV2) {
  window.__readerFrContextRefineV2 = true;
  window.readerFrenchQualityRefresh = (reason = 'external') => schedule(reason, 0);
  window.addEventListener('reader:fr-pipeline-v2-ready', event => schedule(event?.detail?.reason || 'pipeline', 0));
  document.addEventListener('reader:fr-analysis-ready', () => schedule('analysis', 0));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => schedule('boot', 180), { once: true });
  } else {
    schedule('boot', 180);
  }
}

export { normalize, cleanRu, candidateSenses, phraseOverrides, refine };

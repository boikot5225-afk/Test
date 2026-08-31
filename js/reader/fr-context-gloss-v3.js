// toc122 — target-marked French contextual glosses.
// The previous v2 translated a window and then searched the whole Russian result
// for a word resembling any dictionary sense. That still produced dictionary
// nouns for phrases (sans arrêt -> остановки) and could latch onto a neighbour.
// v3 marks the exact source token before ML Kit translation and extracts the
// translated span. Prepositions are retained when they are part of the local
// construction (au courant -> в курсе, sans arrêt -> без остановки).
const SENSES_URL = new URL('../../../frreader/fr_ru_senses.json?v=3', import.meta.url).href;
const CACHE_BASE_KEY = 'an2_reader_fr_context_gloss_v3';
const MAX_CACHE = 3600;
const MAX_ACTIVE = 3;
const CONTEXT_RADIUS = 8;
const MARK_L = '⟦';
const MARK_R = '⟧';

let senses = null;
let sensesPromise = null;
let timer = null;
let observer = null;
let observedRoot = null;
let requestSeq = 0;
let activeRequests = 0;
const pending = new Map();
const failedKeys = new Set();

const RU_VOWELS = new Set(Array.from('аеёиоуыэюя'));
const RU_STOP = new Set(['этот','эта','это','эти','того','тому','тоже','если','когда','чтобы','котор','есть','быть','была','были','было','будет','очень','просто','свой','свои','меня','тебя','него','нему','она','они','оно','или','для','как','что','его','её','еще','ещё','уже','при','над','под','без','через','после','перед']);
const FR_PREPOSITIONAL = new Set(['à','au','aux','de','du','des','en','dans','sur','sous','sans','avec','pour','par','chez','vers','entre','contre','après','avant','depuis','pendant','dès','hors']);
const RU_PREPOSITIONS = new Set(['в','во','на','без','с','со','к','ко','у','из','от','до','для','по','при','через','после','перед','под','над','о','об','про','между','против','за']);

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function normalize(value) {
  return String(value || '').normalize('NFC').replace(/[’‘`´]/g, "'").replace(/[‐‑‒–—]/g, '-').trim().toLocaleLowerCase('fr-FR');
}

function normalizeRu(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^а-я\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeRussian(value, max = 52) {
  try {
    const shared = globalThis.readerFrenchSanitizeRussian?.(value, max);
    if (shared) return shared;
  } catch {}
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s*\[[^\]]*$/g, '').replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(max * .55) ? cut.slice(0, space) : text.slice(0, max)).trim();
}

function currentLang() {
  const raw = String(document.getElementById('reader-reading-view')?.dataset?.readerLang || document.getElementById('reader-chapter-text')?.dataset?.lang || '').trim().toLowerCase();
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
}

function hashText(text) {
  const value = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(scopedKey(CACHE_BASE_KEY)) || '{}');
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
    localStorage.setItem(scopedKey(CACHE_BASE_KEY), JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

async function loadSenses() {
  if (senses) return senses;
  if (sensesPromise) return sensesPromise;
  sensesPromise = fetch(SENSES_URL, { cache: 'force-cache' })
    .then(r => { if (!r.ok) throw new Error(`FR senses HTTP ${r.status}`); return r.json(); })
    .then(data => { if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid FR senses'); senses = data; return data; })
    .finally(() => { sensesPromise = null; });
  return sensesPromise;
}

function wordSurface(element) { return String(element?.dataset?.word || element?.textContent || '').trim(); }
function lemmaFor(surface) {
  try {
    const corrected = globalThis.readerFrenchLexicalOverrideLemmaFor?.(surface);
    if (corrected) return normalize(corrected);
    return normalize(globalThis.readerFrenchLemmaFor?.(surface) || surface);
  } catch { return normalize(surface); }
}

function contextModel(element, radius = CONTEXT_RADIUS) {
  const paragraph = element?.closest?.('.reader-paragraph');
  if (!paragraph) {
    const surface = wordSurface(element);
    return { surface, words: [surface], index: 0, context: surface, marked: `${MARK_L}${surface}${MARK_R}`, prev: '' };
  }
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const absolute = words.indexOf(element);
  if (absolute < 0) {
    const surface = wordSurface(element);
    return { surface, words: [surface], index: 0, context: surface, marked: `${MARK_L}${surface}${MARK_R}`, prev: '' };
  }
  const start = Math.max(0, absolute - radius);
  const end = Math.min(words.length, absolute + radius + 1);
  const slice = words.slice(start, end).map(el => String(el.dataset.word || el.textContent || '').trim()).filter(Boolean);
  const index = absolute - start;
  const surface = slice[index] || wordSurface(element);
  const markedWords = slice.slice();
  markedWords[index] = `${MARK_L}${surface}${MARK_R}`;
  return {
    surface,
    words: slice,
    index,
    context: slice.join(' '),
    marked: markedWords.join(' '),
    prev: index > 0 ? normalize(slice[index - 1]) : '',
  };
}

function russianTokens(value) { return normalizeRu(value).split(/\s+/).filter(t => t.length >= 2); }
function russianRoot(token) { const t = normalizeRu(token).replace(/-/g, ''); return t.length < 4 ? t : t.slice(0, 4); }
function consonantSignature(token) {
  const t = normalizeRu(token).replace(/[^а-я]/g, '');
  let out = '';
  for (const ch of t) {
    if (RU_VOWELS.has(ch) || ch === 'ь' || ch === 'ъ' || ch === 'й') continue;
    if (out.endsWith(ch)) continue;
    out += ch;
    if (out.length >= 4) break;
  }
  return out;
}

function tokenMatchScore(candidateToken, translatedToken) {
  const c = normalizeRu(candidateToken), t = normalizeRu(translatedToken);
  if (!c || !t || RU_STOP.has(c) || RU_STOP.has(t)) return 0;
  if (c === t) return 12;
  const cr = russianRoot(c), tr = russianRoot(t);
  if (cr.length >= 4 && cr === tr) return 8;
  const cs = consonantSignature(c), ts = consonantSignature(t);
  if (Math.min(cs.length, ts.length) >= 3 && (cs === ts || cs.startsWith(ts) || ts.startsWith(cs))) return 5;
  if (Math.min(cs.length, ts.length) >= 3 && cs.slice(0, 3) === ts.slice(0, 3)) return 4;
  if (c.length >= 5 && (c.startsWith(t.slice(0, 4)) || t.startsWith(c.slice(0, 4)))) return 3;
  return 0;
}

function chooseContextToken(candidates, translated) {
  const translatedTokens = russianTokens(translated);
  if (!translatedTokens.length) return '';
  let best = null;
  for (const rawSense of Array.isArray(candidates) ? candidates : []) {
    const sense = sanitizeRussian(rawSense, 90);
    if (!sense) continue;
    for (let ti = 0; ti < translatedTokens.length; ti += 1) {
      for (const candidateToken of russianTokens(sense)) {
        const score = tokenMatchScore(candidateToken, translatedTokens[ti]);
        if (!score) continue;
        const item = { token: translatedTokens[ti], score, ti, sense };
        if (!best || item.score > best.score) best = item;
      }
    }
  }
  return !best || best.score < 4 ? '' : sanitizeRussian(best.token, 38);
}

function trailingRussianPreposition(prefix) {
  const raw = String(prefix || '').replace(/[⟦⟧【】]/g, ' ').trim();
  if (!raw) return '';
  const tokens = raw.split(/\s+/).map(t => normalizeRu(t)).filter(Boolean);
  const last = tokens[tokens.length - 1] || '';
  if (RU_PREPOSITIONS.has(last)) return last;
  return '';
}

function extractMarkedGloss(translated, previousSource = '') {
  const text = String(translated || '').trim();
  if (!text) return '';
  const match = text.match(/[⟦【]\s*([^⟧】]{1,80}?)\s*[⟧】]/u);
  if (!match) return '';
  let target = sanitizeRussian(match[1], 48);
  if (!target) return '';
  if (FR_PREPOSITIONAL.has(normalize(previousSource))) {
    const before = text.slice(0, match.index);
    const prep = trailingRussianPreposition(before);
    if (prep && !normalizeRu(target).startsWith(prep + ' ')) target = `${prep} ${target}`;
  }
  return sanitizeRussian(target, 52);
}

function parsePayload(payloadJson) {
  try { const value = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson; return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}

function existingGloss(element) {
  const wrap = element?.parentElement?.classList?.contains('rw-fr-gloss-wrap') ? element.parentElement : null;
  return { wrap, node: wrap?.querySelector?.(':scope > .rw-fr-gloss-text') || null };
}

function replaceGloss(element, ru, provider, contextKey = '') {
  if (!element?.classList?.contains('rw-migaku-unknown')) return false;
  if (globalThis.readerFrenchIsProperWord?.(wordSurface(element))) return false;
  const translated = sanitizeRussian(ru);
  if (!translated) return false;
  const { wrap, node } = existingGloss(element);
  if (!wrap || !node) return false;
  if (String(node.textContent || '').trim() === translated && wrap.dataset.frContextProvider === provider && (!contextKey || wrap.dataset.frContextKey === contextKey)) return false;
  node.textContent = translated;
  wrap.dataset.frGlossRu = translated;
  wrap.dataset.frContextProvider = provider;
  if (contextKey) wrap.dataset.frContextKey = contextKey;
  return true;
}

function sensesFor(dict, surface, lemma, fallback = '') {
  const out = [], seen = new Set();
  const add = value => {
    const ru = sanitizeRussian(value, 90), key = normalizeRu(ru);
    if (!ru || !key || seen.has(key)) return;
    seen.add(key); out.push(ru);
  };
  add(fallback);
  for (const key of [normalize(surface), normalize(lemma)]) {
    for (const value of Array.isArray(dict?.[key]) ? dict[key] : []) add(value);
  }
  return out.slice(0, 18);
}

function requestContext(element, model, candidates, contextKey) {
  const bridge = globalThis.ReaderFrenchContextTranslate;
  if (!bridge || typeof bridge.translate !== 'function') return false;
  if (activeRequests >= MAX_ACTIVE || pending.has(contextKey) || failedKeys.has(contextKey)) return false;
  const requestId = `frctx3-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;
  const item = { element, surface: model.surface, context: model.context, marked: model.marked, prev: model.prev, candidates, contextKey };
  pending.set(requestId, item); pending.set(contextKey, requestId); activeRequests += 1;
  try { bridge.translate(requestId, model.marked); return true; }
  catch (error) {
    pending.delete(requestId); pending.delete(contextKey); activeRequests = Math.max(0, activeRequests - 1); failedKeys.add(contextKey);
    console.warn('[fr context v3] bridge call failed', error?.message || error); return false;
  }
}

if (typeof window !== 'undefined') {
  window.__readerFrContextTranslateResolve = (requestId, ok, payloadJson) => {
    const item = pending.get(String(requestId || ''));
    if (!item || typeof item !== 'object') return;
    pending.delete(String(requestId || '')); pending.delete(item.contextKey); activeRequests = Math.max(0, activeRequests - 1);
    const payload = parsePayload(payloadJson);
    if (ok) {
      const translated = String(payload.translated || '');
      const marked = extractMarkedGloss(translated, item.prev);
      const fallback = marked || chooseContextToken(item.candidates, translated);
      if (fallback) {
        const cache = readCache();
        cache[item.contextKey] = { ru: fallback, translated: sanitizeRussian(translated, 220), t: Date.now(), provider: marked ? 'mlkit-target-marked' : 'mlkit-target-fallback' };
        saveCache(cache);
        if (item.element?.isConnected) replaceGloss(item.element, fallback, cache[item.contextKey].provider, item.contextKey);
      } else failedKeys.add(item.contextKey);
    } else failedKeys.add(item.contextKey);
    schedule(0);
  };
}

async function scan() {
  if (currentLang() !== 'fr') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const unknown = Array.from(root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]'));
  if (!unknown.length) return;
  let dict = null;
  try { dict = await loadSenses(); } catch (error) { console.warn('[fr context v3] senses unavailable', error?.message || error); return; }
  const cache = readCache();
  for (const element of unknown) {
    const pair = existingGloss(element);
    if (!pair.wrap || !pair.node) continue;
    const surface = wordSurface(element);
    if (!surface || globalThis.readerFrenchIsProperWord?.(surface)) continue;
    const lemma = lemmaFor(surface);
    const model = contextModel(element);
    const contextKey = `${normalize(surface)}|${hashText(normalize(model.context))}`;
    const cached = sanitizeRussian(cache[contextKey]?.ru || '');
    if (cached) { replaceGloss(element, cached, cache[contextKey]?.provider || 'context-cache', contextKey); continue; }
    const candidates = sensesFor(dict, surface, lemma, pair.node.textContent || '');
    requestContext(element, model, candidates, contextKey);
  }
}

function contextSimilarity(a, b) {
  const aa = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const bb = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap += 1;
  return overlap / Math.max(aa.size, bb.size);
}

function applyDeepSeekAnalysis(detail = {}) {
  if (currentLang() !== 'fr') return;
  const surface = normalize(detail.surface || detail.word || '');
  const ru = sanitizeRussian(detail.ru || detail.translation || detail.meaning || '');
  if (!surface || !ru || detail.isProper) return;
  const aiContext = normalize(detail.context || '');
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  for (const element of root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')) {
    if (normalize(wordSurface(element)) !== surface) continue;
    const model = contextModel(element);
    const localContext = normalize(model.context);
    if (aiContext && localContext && contextSimilarity(aiContext, localContext) < .38 && !aiContext.includes(localContext) && !localContext.includes(aiContext)) continue;
    const key = `${surface}|${hashText(localContext)}`;
    replaceGloss(element, ru, 'deepseek-context', key);
    const cache = readCache(); cache[key] = { ru, t: Date.now(), provider: 'deepseek-context' }; saveCache(cache);
  }
}

function schedule(delay = 80) { clearTimeout(timer); timer = setTimeout(() => { void scan(); }, Math.max(0, Number(delay) || 0)); }
function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot && typeof MutationObserver === 'function') {
    observer?.disconnect(); observedRoot = root;
    observer = new MutationObserver(() => schedule(120));
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','data-word'] });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerFrContextGlossV3) {
  window.__readerFrContextGlossV3 = true;
  document.addEventListener('reader:fr-analysis-ready', event => { applyDeepSeekAnalysis(event?.detail || {}); schedule(0); });
  window.addEventListener('reader:fr-vocab-ready', () => schedule(0));
  window.addEventListener('reader:chapter-rendered', bind);
  window.addEventListener('reader:book-opened', bind);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
}

export { chooseContextToken, extractMarkedGloss, contextModel, sensesFor, sanitizeRussian };

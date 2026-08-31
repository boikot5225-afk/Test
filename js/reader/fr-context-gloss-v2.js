// toc121 — target-aware French contextual glosses.
// ML Kit translates a tight local window. We then align the *actual Russian token*
// back to WikDict candidate roots, so the inline gloss follows the sentence form
// (плохой -> плохо, остановка -> остановки) instead of blindly printing sense #1.
const SENSES_URL = new URL('../../../frreader/fr_ru_senses.json?v=2', import.meta.url).href;
const CACHE_BASE_KEY = 'an2_reader_fr_context_gloss_v2';
const MAX_CACHE = 3200;
const MAX_ACTIVE = 4;
const CONTEXT_RADIUS = 4;

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
const RU_STOP = new Set([
  'этот','эта','это','эти','того','тому','тоже','если','когда','чтобы','котор',
  'есть','быть','была','были','было','будет','очень','просто','свой','свои',
  'меня','тебя','него','нему','она','они','оно','или','для','как','что','его',
  'её','еще','ещё','уже','при','над','под','без','через','после','перед'
]);

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('fr-FR');
}

function normalizeRu(value) {
  return String(value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^а-я\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeRussian(value, max = 38) {
  try {
    const shared = globalThis.readerFrenchSanitizeRussian?.(value, max);
    if (shared) return shared;
  } catch {}
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  text = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\[[^\]]*$/g, '')
    .replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '')
    .trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 18 ? cut.slice(0, space) : text.slice(0, max)).trim();
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang ||
    ''
  ).trim().toLowerCase();
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
}

function hashText(text) {
  const value = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
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
    .then((response) => {
      if (!response.ok) throw new Error(`FR senses HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid FR senses');
      senses = data;
      return data;
    })
    .finally(() => { sensesPromise = null; });
  return sensesPromise;
}

function wordSurface(element) {
  return String(element?.dataset?.word || element?.textContent || '').trim();
}

function lemmaFor(surface) {
  try {
    const corrected = globalThis.readerFrenchLexicalOverrideLemmaFor?.(surface);
    if (corrected) return normalize(corrected);
    return normalize(globalThis.readerFrenchLemmaFor?.(surface) || surface);
  } catch {
    return normalize(surface);
  }
}

function contextWords(element, radius = CONTEXT_RADIUS) {
  const paragraph = element?.closest?.('.reader-paragraph');
  if (!paragraph) return normalize(wordSurface(element));
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const index = words.indexOf(element);
  if (index < 0) return normalize(wordSurface(element));
  const start = Math.max(0, index - radius);
  const end = Math.min(words.length, index + radius + 1);
  return words.slice(start, end)
    .map((word) => String(word.dataset.word || word.textContent || '').trim())
    .filter(Boolean)
    .join(' ');
}

function russianTokens(value) {
  return normalizeRu(value).split(/\s+/).filter((token) => token.length >= 2);
}

function russianRoot(token) {
  const t = normalizeRu(token).replace(/-/g, '');
  if (t.length < 4) return t;
  return t.slice(0, 4);
}

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
  const c = normalizeRu(candidateToken);
  const t = normalizeRu(translatedToken);
  if (!c || !t || RU_STOP.has(c) || RU_STOP.has(t)) return 0;
  if (c === t) return 12;
  const cr = russianRoot(c);
  const tr = russianRoot(t);
  if (cr.length >= 4 && cr === tr) return 8;
  const cs = consonantSignature(c);
  const ts = consonantSignature(t);
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
    const sense = sanitizeRussian(rawSense, 80);
    if (!sense) continue;
    const candidateTokens = russianTokens(sense);
    for (let ti = 0; ti < translatedTokens.length; ti += 1) {
      const translatedToken = translatedTokens[ti];
      for (const candidateToken of candidateTokens) {
        const score = tokenMatchScore(candidateToken, translatedToken);
        if (!score) continue;
        const stopPenalty = RU_STOP.has(translatedToken) ? 20 : 0;
        const item = { token: translatedToken, score: score - stopPenalty, ti, sense };
        if (!best || item.score > best.score) best = item;
      }
    }
  }

  if (!best || best.score < 4) return '';
  return sanitizeRussian(best.token, 34);
}

function parsePayload(payloadJson) {
  try {
    const value = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function existingGloss(element) {
  const wrap = element?.parentElement?.classList?.contains('rw-fr-gloss-wrap') ? element.parentElement : null;
  const node = wrap?.querySelector?.(':scope > .rw-fr-gloss-text') || null;
  return { wrap, node };
}

function replaceGloss(element, ru, provider, contextKey = '') {
  if (!element?.classList?.contains('rw-migaku-unknown')) return false;
  if (globalThis.readerFrenchIsProperWord?.(wordSurface(element))) return false;
  const translated = sanitizeRussian(ru);
  if (!translated) return false;
  const { wrap, node } = existingGloss(element);
  if (!wrap || !node) return false;
  const same = String(node.textContent || '').trim() === translated
    && wrap.dataset.frContextProvider === provider
    && (!contextKey || wrap.dataset.frContextKey === contextKey);
  if (same) return false;
  node.textContent = translated;
  wrap.dataset.frGlossRu = translated;
  wrap.dataset.frContextProvider = provider;
  if (contextKey) wrap.dataset.frContextKey = contextKey;
  return true;
}

function sensesFor(dict, surface, lemma) {
  const values = dict?.[normalize(lemma)] || dict?.[normalize(surface)] || [];
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const ru = sanitizeRussian(value, 80);
    const key = normalizeRu(ru);
    if (!ru || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(ru);
    if (out.length >= 14) break;
  }
  return out;
}

function requestContext(surface, context, candidates, contextKey) {
  const bridge = globalThis.ReaderFrenchContextTranslate;
  if (!bridge || typeof bridge.translate !== 'function') return false;
  if (activeRequests >= MAX_ACTIVE || pending.has(contextKey) || failedKeys.has(contextKey)) return false;
  const requestId = `frctx2-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;
  pending.set(requestId, { surface, context, candidates, contextKey });
  pending.set(contextKey, requestId);
  activeRequests += 1;
  try {
    bridge.translate(requestId, context);
    return true;
  } catch (error) {
    pending.delete(requestId);
    pending.delete(contextKey);
    activeRequests = Math.max(0, activeRequests - 1);
    failedKeys.add(contextKey);
    console.warn('[fr context v2] bridge call failed', error?.message || error);
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.__readerFrContextTranslateResolve = (requestId, ok, payloadJson) => {
    const item = pending.get(String(requestId || ''));
    if (!item || typeof item !== 'object') return;
    pending.delete(String(requestId || ''));
    pending.delete(item.contextKey);
    activeRequests = Math.max(0, activeRequests - 1);
    const payload = parsePayload(payloadJson);
    if (ok) {
      const selected = chooseContextToken(item.candidates, payload.translated || '');
      if (selected) {
        const cache = readCache();
        cache[item.contextKey] = {
          ru: selected,
          translated: sanitizeRussian(payload.translated || '', 180),
          t: Date.now(),
          provider: 'mlkit-target-token',
        };
        saveCache(cache);
      } else {
        failedKeys.add(item.contextKey);
      }
    } else {
      failedKeys.add(item.contextKey);
    }
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
  try { dict = await loadSenses(); }
  catch (error) {
    console.warn('[fr context v2] senses unavailable', error?.message || error);
    return;
  }

  const cache = readCache();
  for (const element of unknown) {
    const pair = existingGloss(element);
    if (!pair.wrap || !pair.node || !String(pair.node.textContent || '').trim()) continue;
    const surface = wordSurface(element);
    if (!surface || globalThis.readerFrenchIsProperWord?.(surface)) continue;
    const lemma = lemmaFor(surface);
    const candidates = sensesFor(dict, surface, lemma);
    if (!candidates.length) continue;
    const context = contextWords(element);
    const contextKey = `${normalize(lemma || surface)}|${hashText(normalize(context))}`;
    const cached = sanitizeRussian(cache[contextKey]?.ru || '');
    if (cached) {
      replaceGloss(element, cached, 'mlkit-target-cache', contextKey);
      continue;
    }
    requestContext(surface, context, candidates, contextKey);
  }
}

function applyDeepSeekAnalysis(detail = {}) {
  if (currentLang() !== 'fr') return;
  const surface = normalize(detail.surface || detail.word || '');
  const ru = sanitizeRussian(detail.ru || detail.translation || detail.meaning || '');
  if (!surface || !ru || detail.isProper) return;
  const context = normalize(detail.context || '');
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;

  for (const element of root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')) {
    if (normalize(wordSurface(element)) !== surface) continue;
    const localContext = normalize(contextWords(element));
    if (context && localContext && context !== localContext && !context.includes(localContext) && !localContext.includes(context)) continue;
    const lemma = lemmaFor(surface);
    const key = `${normalize(lemma || surface)}|${hashText(localContext)}`;
    replaceGloss(element, ru, 'deepseek-context', key);
    const cache = readCache();
    cache[key] = { ru, t: Date.now(), provider: 'deepseek-context' };
    saveCache(cache);
  }
}

function schedule(delay = 60) {
  clearTimeout(timer);
  timer = setTimeout(() => { void scan(); }, Math.max(0, Number(delay) || 0));
}

function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot && typeof MutationObserver === 'function') {
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver((records) => {
      if (currentLang() !== 'fr') return;
      if (records.some((record) => record.type === 'childList' || record.type === 'attributes')) schedule(80);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-word'],
    });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerFrContextGlossV2) {
  window.__readerFrContextGlossV2 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.addEventListener('pageshow', bind);
  window.addEventListener('reader:fr-vocab-ready', () => schedule(20));
  window.addEventListener('reader:fr-lexical-corrected', () => schedule(10));
  window.addEventListener('an2:languagechange', () => schedule(20));
  document.addEventListener('reader:fr-analysis-ready', (event) => applyDeepSeekAnalysis(event?.detail || {}));
}

export {
  normalize,
  normalizeRu,
  russianRoot,
  consonantSignature,
  tokenMatchScore,
  chooseContextToken,
  contextWords,
  sanitizeRussian,
};

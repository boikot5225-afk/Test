// toc82 coverage fallback for English Unknown words that the main gloss layer
// could not resolve. Order: full bundled WikDict -> morphology/compound lookup
// -> tiny high-confidence exceptions/proper names -> local ML Kit for the rare
// residual miss. Existing glosses are never blanked or delayed by this module.

const FULL_DICT_URL = new URL('../../../wikdict/en_ru_core.json?v=2', import.meta.url).href;
const SPECIAL_GLOSSES = Object.freeze({
  realignment: 'перестройка',
  reuters: 'Рейтерс',
  oilfield: 'нефтепромысел',
  oilfields: 'нефтепромыслы',
});

let dictionary = null;
let dictionaryPromise = null;
let timer = null;
let observer = null;
let observedRoot = null;
let residualSeq = 0;
let residualBlockedUntil = 0;

const residualCache = new Map();
const residualInFlight = new Set();
const residualRequests = new Map();

function normalize(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('en-US');
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).trim().toLowerCase();
  return raw === 'english' || raw === 'en' || raw.startsWith('en-') ? 'en' : raw;
}

function compactRussian(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  const first = text.split(/\s*\|\s*|\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || text;
  if (first.length <= 34) return first;
  let out = '';
  for (const part of first.split(/\s+/)) {
    const next = out ? `${out} ${part}` : part;
    if (next.length > 34) break;
    out = next;
  }
  return out || first.slice(0, 34).trim();
}

async function loadDictionary() {
  if (dictionary) return dictionary;
  if (dictionaryPromise) return dictionaryPromise;
  dictionaryPromise = fetch(FULL_DICT_URL, { cache:'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`full EN→RU dictionary HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid full EN→RU dictionary');
      dictionary = data;
      return data;
    })
    .finally(() => { dictionaryPromise = null; });
  return dictionaryPromise;
}

function pushUnique(list, value) {
  const key = normalize(value);
  if (key && !list.includes(key)) list.push(key);
}

function candidatesFor(surface) {
  const raw = normalize(surface);
  const out = [];
  pushUnique(out, raw);

  try { pushUnique(out, globalThis.readerEnglishLemmaFor?.(surface)); } catch {}

  // Possessives: Venezuela's -> Venezuela, workers' -> workers.
  if (raw.endsWith("'s")) pushUnique(out, raw.slice(0, -2));
  if (raw.endsWith("s'")) pushUnique(out, raw.slice(0, -1));

  // Common inflections for unranked words that are absent from Reader's compact
  // morphology table. Exact/official lemma candidates above always win first.
  if (/ies$/.test(raw) && raw.length > 4) pushUnique(out, raw.slice(0, -3) + 'y');
  if (/ves$/.test(raw) && raw.length > 4) {
    pushUnique(out, raw.slice(0, -3) + 'f');
    pushUnique(out, raw.slice(0, -3) + 'fe');
  }
  if (/es$/.test(raw) && raw.length > 4) pushUnique(out, raw.slice(0, -2));
  if (/s$/.test(raw) && !/ss$/.test(raw) && raw.length > 3) pushUnique(out, raw.slice(0, -1));
  if (/ing$/.test(raw) && raw.length > 5) {
    const stem = raw.slice(0, -3);
    pushUnique(out, stem);
    pushUnique(out, stem + 'e');
    if (/(.)\1$/.test(stem)) pushUnique(out, stem.slice(0, -1));
  }
  if (/ed$/.test(raw) && raw.length > 4) {
    const stem = raw.slice(0, -2);
    pushUnique(out, stem);
    pushUnique(out, stem + 'e');
    if (/(.)\1$/.test(stem)) pushUnique(out, stem.slice(0, -1));
  }

  // Dictionary editions are inconsistent about compound spelling.
  if (raw.includes('-')) {
    pushUnique(out, raw.replace(/-/g, ' '));
    pushUnique(out, raw.replace(/-/g, ''));
  }
  return out;
}

function lookup(dict, surface) {
  const candidates = candidatesFor(surface);
  for (const key of candidates) {
    const special = compactRussian(SPECIAL_GLOSSES[key]);
    if (special) return { key:`special:${key}`, ru:special };
    const ru = compactRussian(dict[key]);
    if (ru) return { key, ru };
  }

  // Closed compounds are common in news prose. Try every plausible split as a
  // dictionary phrase: oilfield -> "oil field" -> нефтепромысел. This also runs
  // on morphology candidates, so oilfields -> oilfield -> "oil field".
  for (const key of candidates) {
    if (!/^[a-z]+$/.test(key) || key.length < 6) continue;
    for (let i = 2; i <= key.length - 2; i += 1) {
      const phrase = `${key.slice(0, i)} ${key.slice(i)}`;
      const ru = compactRussian(dict[phrase]);
      if (ru) return { key:phrase, ru };
    }
  }
  return null;
}

function ensureWrapper(el) {
  let wrap = el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
  if (!wrap && el?.parentNode) {
    wrap = document.createElement('span');
    wrap.className = 'rw-en-gloss-wrap';
    wrap.dataset.enGloss = '1';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  if (!wrap) return null;
  let node = wrap.querySelector(':scope > .rw-en-gloss-text');
  if (!node) {
    node = document.createElement('span');
    node.className = 'rw-en-gloss-text';
    node.setAttribute('aria-hidden', 'true');
    wrap.appendChild(node);
  }
  return { wrap, node };
}

function fontSize(surface, ru) {
  const a = Math.max(2, Array.from(String(surface || '')).length);
  const b = Math.max(1, Array.from(String(ru || '')).length);
  const ratio = b / a;
  return `${Math.max(0.27, Math.min(0.46, 0.47 / Math.sqrt(Math.max(1, ratio)))).toFixed(3)}em`;
}

function fillElement(el, ru, lookupKey = '') {
  const translated = compactRussian(ru);
  if (!translated) return false;
  const pair = ensureWrapper(el);
  if (!pair) return false;
  const surface = String(el.dataset.word || el.textContent || '').trim();
  pair.wrap.dataset.enGlossVisible = '1';
  pair.node.textContent = translated;
  pair.wrap.dataset.enGlossRu = translated;
  if (lookupKey) pair.wrap.dataset.enGlossLookup = lookupKey;
  pair.wrap.style.setProperty('--en-gloss-font', fontSize(surface, translated));
  return true;
}

function transliterateProperName(surface) {
  const original = String(surface || '').replace(/[’‘]/g, "'").trim();
  if (!/^[A-Z][A-Za-z'.-]{2,}$/.test(original)) return '';
  const special = SPECIAL_GLOSSES[normalize(original)];
  if (special) return special;

  // Conservative orthographic fallback for a proper name absent from WikDict.
  // It is intentionally last in the dictionary path and is better than an empty
  // Unknown label; named entities are not semantically "translated" anyway.
  const rules = [
    ['shch','щ'],['tch','ч'],['sch','ш'],['sh','ш'],['ch','ч'],['ph','ф'],
    ['th','т'],['kh','х'],['zh','ж'],['qu','кв'],['ck','к'],['ng','нг'],
    ['wh','в'],['ee','и'],['oo','у'],['ea','и'],['ou','ау'],['ow','оу'],
  ];
  const single = {
    a:'а',b:'б',c:'к',d:'д',e:'е',f:'ф',g:'г',h:'х',i:'и',j:'дж',k:'к',l:'л',m:'м',
    n:'н',o:'о',p:'п',q:'к',r:'р',s:'с',t:'т',u:'у',v:'в',w:'в',x:'кс',y:'й',z:'з',
    "'":'', '-':'-', '.':'.',
  };
  let rest = original.toLowerCase();
  let out = '';
  while (rest) {
    let matched = false;
    for (const [from, to] of rules) {
      if (rest.startsWith(from)) {
        out += to;
        rest = rest.slice(from.length);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = rest[0];
    out += single[ch] ?? ch;
    rest = rest.slice(1);
  }
  return out ? out[0].toLocaleUpperCase('ru-RU') + out.slice(1) : '';
}

function allUnknownElements() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  return Array.from(root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]'));
}

function fillResidualSource(source, translated) {
  const key = normalize(source);
  const ru = compactRussian(translated);
  if (!key || !ru) return false;
  residualCache.set(key, ru);
  let changed = false;
  for (const el of allUnknownElements()) {
    const surface = String(el.dataset.word || el.textContent || '').trim();
    if (normalize(surface) !== key) continue;
    const pair = ensureWrapper(el);
    if (pair && !String(pair.node.textContent || '').trim()) {
      changed = fillElement(el, ru, `mlkit:${key}`) || changed;
    }
  }
  return changed;
}

function parsePayload(payloadJson) {
  try {
    const value = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

if (typeof window !== 'undefined') {
  window.__readerEnResidualProgress = (requestId, source, translated) => {
    const ru = compactRussian(translated);
    const key = normalize(source);
    if (key) residualInFlight.delete(key);
    if (ru) fillResidualSource(source, ru);
  };

  window.__readerEnResidualResolve = (requestId, ok, payloadJson) => {
    const words = residualRequests.get(String(requestId || '')) || [];
    residualRequests.delete(String(requestId || ''));
    for (const word of words) residualInFlight.delete(normalize(word));

    const payload = parsePayload(payloadJson);
    if (ok) {
      const translations = payload.translations && typeof payload.translations === 'object'
        ? payload.translations : {};
      for (const [source, translated] of Object.entries(translations)) {
        fillResidualSource(source, translated);
      }
    } else {
      residualBlockedUntil = Date.now() + 20_000;
      console.warn('[en gloss residual] ML Kit unavailable', payload.message || 'unknown error');
    }
    schedule(80);
  };
}

function requestResidual(words) {
  const bridge = globalThis.ReaderEnglishResidualTranslate;
  if (!bridge || typeof bridge.translateBatch !== 'function') return false;
  if (Date.now() < residualBlockedUntil) return false;

  const unique = [];
  for (const word of words || []) {
    const raw = String(word || '').trim();
    const key = normalize(raw);
    if (!key || residualCache.has(key) || residualInFlight.has(key)) continue;
    residualInFlight.add(key);
    unique.push(raw);
    if (unique.length >= 24) break;
  }
  if (!unique.length) return false;

  const requestId = `en-residual-${Date.now().toString(36)}-${(++residualSeq).toString(36)}`;
  residualRequests.set(requestId, unique);
  try {
    bridge.translateBatch(requestId, JSON.stringify(unique));
    return true;
  } catch (error) {
    residualRequests.delete(requestId);
    for (const word of unique) residualInFlight.delete(normalize(word));
    residualBlockedUntil = Date.now() + 20_000;
    console.warn('[en gloss residual] bridge call failed', error?.message || error);
    return false;
  }
}

async function scan() {
  if (currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  let dict;
  try { dict = await loadDictionary(); }
  catch (error) {
    console.warn('[en full gloss fallback] dictionary unavailable', error?.message || error);
    return;
  }

  const unresolved = [];
  for (const el of allUnknownElements()) {
    const pair = ensureWrapper(el);
    if (!pair) continue;
    pair.wrap.dataset.enGlossVisible = '1';
    if (String(pair.node.textContent || '').trim()) continue;

    const surface = String(el.dataset.word || el.textContent || '').trim();
    const key = normalize(surface);
    const cached = compactRussian(residualCache.get(key));
    if (cached) {
      fillElement(el, cached, `mlkit-cache:${key}`);
      continue;
    }

    const found = lookup(dict, surface);
    if (found) {
      fillElement(el, found.ru, found.key);
      continue;
    }

    // Proper names should never sit there as a naked red underline while a
    // model downloads. Transliteration is the correct fallback semantics.
    const proper = transliterateProperName(surface);
    if (proper) {
      fillElement(el, proper, 'proper-name');
      continue;
    }

    unresolved.push(surface);
  }

  // The full dictionary handles the overwhelming majority. ML Kit receives
  // only the genuinely missing common words, normally a handful per page.
  requestResidual(unresolved);
}

function schedule(delay = 40) {
  clearTimeout(timer);
  timer = setTimeout(() => { void scan(); }, Math.max(0, Number(delay) || 0));
}

function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot && typeof MutationObserver === 'function') {
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(() => schedule(50));
    observer.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class','data-word'] });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerEnFullGlossFallbackV2) {
  window.__readerEnFullGlossFallbackV2 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();
  window.addEventListener('pageshow', bind);
  window.addEventListener('reader:en-vocab-ready', () => schedule(0));
  window.addEventListener('an2:languagechange', () => schedule(0));
}

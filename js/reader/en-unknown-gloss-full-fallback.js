// toc81 fallback for English Unknown words that the main gloss layer could not
// resolve. It reads the FULL bundled WikDict JSON and only fills empty glosses;
// existing translations and Chinese/Japanese rendering are untouched.

const FULL_DICT_URL = new URL('../../../wikdict/en_ru_core.json?v=2', import.meta.url).href;
let dictionary = null;
let dictionaryPromise = null;
let timer = null;
let observer = null;
let observedRoot = null;

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
  for (const key of candidatesFor(surface)) {
    const ru = compactRussian(dict[key]);
    if (ru) return { key, ru };
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

  for (const el of root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')) {
    const pair = ensureWrapper(el);
    if (!pair) continue;
    pair.wrap.dataset.enGlossVisible = '1';
    if (String(pair.node.textContent || '').trim()) continue;
    const surface = String(el.dataset.word || el.textContent || '').trim();
    const found = lookup(dict, surface);
    if (!found) continue;
    pair.node.textContent = found.ru;
    pair.wrap.dataset.enGlossRu = found.ru;
    pair.wrap.dataset.enGlossLookup = found.key;
    pair.wrap.style.setProperty('--en-gloss-font', fontSize(surface, found.ru));
  }
}

function schedule(delay = 40) {
  clearTimeout(timer);
  timer = setTimeout(() => { void scan(); }, Math.max(0, Number(delay) || 0));
}

function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot) {
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(() => schedule(50));
    observer.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class','data-word'] });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerEnFullGlossFallbackV1) {
  window.__readerEnFullGlossFallbackV1 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();
  window.addEventListener('pageshow', bind);
  window.addEventListener('reader:en-vocab-ready', () => schedule(0));
  window.addEventListener('an2:languagechange', () => schedule(0));
}

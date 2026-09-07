// toc134 — Spanish lexical owner for Reader word cards.
// Mirrors the mature French lexical route, but consumes only Spanish
// WordHoard frequency/morphology and bundled ES→RU WikDict assets.
// Never falls through to French verbs/nouns.
const DICT_URL = new URL('../../../esreader/es_ru_core.json?v=1', import.meta.url).href;

let dictionary = null;
let dictionaryPromise = null;
const analysisOverrides = new Map();
const properLemmas = new Set();

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('es-ES');
}

function deaccent(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

function sanitizeRussian(value, max = 72) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/u.test(text)) return '';
  text = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[[^\]]{0,32}\]$/g, '')
    .replace(/\s*\[[^\]]*$/g, '')
    .replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '')
    .trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > Math.floor(max * .58) ? cut.slice(0, space) : text.slice(0, max)).trim();
}

function mapPos(raw) {
  const pos = String(raw || '').trim().toLowerCase();
  if (pos.includes('proper') || pos === 'propn' || pos === 'name' || pos.includes('nombre propio')) return 'proper_noun';
  if (pos === 'aux' || pos.includes('verb') || pos.includes('verbo')) return 'verb';
  if (pos.includes('noun') || pos.includes('sustant') || pos === 'nombre' || pos === 'subst') return 'noun';
  if (pos.includes('adj')) return 'adjective';
  if (pos.includes('adv')) return 'adverb';
  if (pos.includes('prep') || pos.includes('adp')) return 'preposition';
  if (pos.includes('pron')) return 'pronoun';
  if (pos.includes('conj') || pos === 'cconj' || pos === 'sconj') return 'other';
  return 'other';
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'spanish' || raw === 'español' || raw === 'es' || raw.startsWith('es-') ? 'es' : raw;
}

async function loadDictionary() {
  if (dictionary) return dictionary;
  if (dictionaryPromise) return dictionaryPromise;
  dictionaryPromise = fetch(DICT_URL, { cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`Spanish core dictionary HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid Spanish core dictionary');
      dictionary = data;
      return data;
    })
    .finally(() => { dictionaryPromise = null; });
  return dictionaryPromise;
}

async function vocabularyData() {
  const loader = globalThis.readerLoadSpanishVocabularyData;
  if (typeof loader !== 'function') return null;
  try { return await loader(); }
  catch (error) {
    console.warn('[es lexical v1] vocabulary data unavailable', error?.message || error);
    return null;
  }
}

function baseLemma(surface) {
  const normalized = normalize(surface);
  if (!normalized) return '';
  const override = analysisOverrides.get(normalized);
  if (override?.lemma) return override.lemma;
  try {
    const lemma = normalize(globalThis.readerSpanishLemmaFor?.(normalized) || normalized);
    return lemma || normalized;
  } catch { return normalized; }
}

function rankedHit(data, candidate) {
  return data?.rankFold?.get?.(normalize(candidate)) || null;
}

function mappedLemma(data, candidate) {
  const raw = normalize(candidate);
  if (!raw) return '';
  const mapped = normalize(data?.lemma?.get?.(raw) || '');
  if (mapped) return mapped;
  const hit = rankedHit(data, raw);
  return normalize(hit?.word || raw);
}

// Spanish object/reflexive clitics can attach to infinitives, gerunds and
// affirmatives (hacerlo, cometerlos, atreverse). Only detach when the remaining
// form is actually known by the generated morphology/frequency data, so nouns
// such as "Carlos" are never mangled merely because they end in -los.
function cliticLemma(surface, data) {
  const original = normalize(surface);
  if (!original || !data) return '';
  const suffixes = ['melos','melas','melo','mela','telos','telas','telo','tela','selos','selas','selo','sela','nos','los','las','les','me','te','se','lo','la','le','os'];
  const queue = [{ value: original, depth: 0 }];
  const seen = new Set([original]);
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (depth >= 2) continue;
    for (const suffix of suffixes) {
      if (!value.endsWith(suffix) || value.length <= suffix.length + 2) continue;
      for (const rawBase of [value.slice(0, -suffix.length), deaccent(value.slice(0, -suffix.length))]) {
        const base = normalize(rawBase);
        if (!base || seen.has(base)) continue;
        seen.add(base);
        const mapped = mappedLemma(data, base);
        const mappedHit = rankedHit(data, mapped);
        const baseMapped = normalize(data?.lemma?.get?.(base) || '');
        if (baseMapped && rankedHit(data, baseMapped)) return baseMapped;
        if (mappedHit && mapped !== original) return mapped;
        queue.push({ value: base, depth: depth + 1 });
      }
    }
  }
  return '';
}

async function lemmaFor(surface) {
  const normalized = normalize(surface);
  if (!normalized) return '';
  const direct = baseLemma(normalized);
  const data = await vocabularyData();
  if (direct && direct !== normalized) return direct;
  const clitic = cliticLemma(normalized, data);
  return clitic || direct || normalized;
}

function entryForLemma(data, lemma) {
  const hit = rankedHit(data, lemma);
  if (!Number.isInteger(hit?.index)) return null;
  return { ...data.entries[hit.index], index: hit.index, rank: hit.index + 1 };
}

function startsWithSpanishUpper(value) {
  return /^[A-ZÁÉÍÓÚÜÑ]/u.test(String(value || '').trim());
}

function textBeforeElement(element, max = 80) {
  try {
    const paragraph = element?.closest?.('.reader-paragraph') || document.getElementById('reader-chapter-text');
    if (!paragraph || typeof document?.createRange !== 'function') return '';
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEndBefore(element);
    return String(range.toString() || '').slice(-max);
  } catch { return ''; }
}

function chapterProperHeuristic(surface) {
  const raw = String(surface || '').trim();
  if (!raw || typeof document === 'undefined') return false;
  const wanted = normalize(raw);
  const root = document.getElementById('reader-chapter-text');
  if (!root) return false;
  const matches = Array.from(root.querySelectorAll('.reader-word[data-word]'))
    .filter(el => normalize(el.dataset.word || el.textContent || '') === wanted);
  if (!matches.length) return false;
  let capitals = 0;
  let lowers = 0;
  let nonInitial = 0;
  for (const el of matches) {
    const shown = String(el.textContent || el.dataset.word || '').trim();
    const upper = startsWithSpanishUpper(shown);
    if (upper) capitals += 1; else lowers += 1;
    const before = textBeforeElement(el).trimEnd();
    const sentenceInitial = !before || /[.!?…¡¿][\s"'«»“”)]*$/u.test(before);
    if (upper && !sentenceInitial) nonInitial += 1;
  }
  return capitals > 0 && lowers === 0 && nonInitial > 0;
}

function cachedOverride(surface, lemma) {
  return analysisOverrides.get(normalize(surface)) || analysisOverrides.get(normalize(lemma)) || null;
}

function isProper(surface) {
  const normalized = normalize(surface);
  const override = analysisOverrides.get(normalized);
  if (override && Object.prototype.hasOwnProperty.call(override, 'isProper')) return !!override.isProper;
  const lemma = override?.lemma || baseLemma(normalized);
  return properLemmas.has(normalize(lemma)) || chapterProperHeuristic(surface);
}

async function analyze(surface) {
  if (currentLang() && currentLang() !== 'es') return null;
  const normalized = normalize(surface);
  if (!normalized) return null;
  const data = await vocabularyData();
  const lemma = await lemmaFor(normalized);
  const ranked = entryForLemma(data, lemma);
  const override = cachedOverride(normalized, lemma);
  let dict = null;
  try { dict = await loadDictionary(); } catch {}
  const ru = sanitizeRussian(override?.ru || dict?.[lemma] || dict?.[normalized] || '');
  const pos = override?.pos || mapPos(ranked?.pos);
  const proper = !!override?.isProper || isProper(surface) || pos === 'proper_noun';
  if (!ranked && !ru && !override && !proper) return null;
  return {
    pos: proper ? 'proper_noun' : pos,
    lemma,
    infinitive: pos === 'verb' ? lemma : '',
    es: lemma,
    ru,
    meaning: ru,
    gender: override?.gender || '',
    level: override?.level || 'A2',
    rank: ranked?.rank || null,
    _source: override ? (override.source || 'es-analysis-cache') : 'es-open-lexical',
    _note: ranked
      ? (lemma !== normalized ? `лемма ${lemma} · частотность #${ranked.rank}` : `частотность #${ranked.rank}`)
      : (lemma !== normalized ? `лемма ${lemma}` : 'испанский словарь'),
    context_pos: override?.pos || '',
    usage_pos: override?.pos || '',
    isProper: proper,
  };
}

async function analyzeContext(surface, context = '') {
  const base = await analyze(surface);
  if (!base) return null;
  return { ...base, context: String(context || '').trim(), _source: base._source || 'es-open-lexical' };
}

function rememberAnalysis(detail = {}) {
  const surface = normalize(detail.surface || detail.word || '');
  const lemma = normalize(detail.lemma || surface);
  if (!surface || !lemma) return;
  const pos = mapPos(detail.context_pos || detail.usage_pos || detail.pos || '');
  const ru = sanitizeRussian(detail.ru || detail.translation || detail.meaning || '');
  const item = {
    lemma,
    pos,
    ru,
    gender: String(detail.gender || '').trim(),
    level: String(detail.level || '').trim(),
    isProper: !!detail.isProper || pos === 'proper_noun',
    context: String(detail.context || '').trim(),
    t: Date.now(),
    source: String(detail.source || 'es-analysis').trim(),
  };
  // A contextual sense belongs to one occurrence; never globally poison a
  // homograph such as banco/vela/capital. Context-free lexical corrections may
  // be reused across taps.
  if (!item.context) analysisOverrides.set(surface, item);
  if (item.isProper) properLemmas.add(lemma);
  try {
    window.dispatchEvent(new CustomEvent('reader:es-lexical-corrected', { detail: { surface, ...item } }));
    window.dispatchEvent(new CustomEvent('reader:es-vocab-ready'));
  } catch {}
}

function overrideLemma(surface) {
  return analysisOverrides.get(normalize(surface))?.lemma || '';
}

if (typeof window !== 'undefined' && !window.__readerEsLexicalPipelineV1) {
  window.__readerEsLexicalPipelineV1 = true;
  globalThis.readerSpanishLexicalAnalysisFor = analyze;
  globalThis.readerSpanishContextualAnalysisFor = analyzeContext;
  globalThis.readerSpanishLexicalOverrideLemmaFor = overrideLemma;
  globalThis.readerSpanishSanitizeRussian = sanitizeRussian;
  // Keep the stricter chapter-aware proper-name helper already installed by the
  // Spanish reading pipeline; fill it only if that owner has not booted yet.
  if (typeof globalThis.readerSpanishIsProperWord !== 'function') globalThis.readerSpanishIsProperWord = isProper;
  document.addEventListener('reader:es-analysis-ready', event => rememberAnalysis(event?.detail || {}));
}

export { normalize, sanitizeRussian, mapPos, analyze, analyzeContext, rememberAnalysis, lemmaFor, cliticLemma };
// toc121 — one French lexical pipeline for the word card + reader vocabulary layer.
// It deliberately consumes the same generated Wordhoard/WikDict assets as
// fr-vocab-estimate.js so morphology, rank, POS and inline gloss cannot disagree.
const DICT_URL = new URL('../../../frreader/fr_ru_core.json?v=2', import.meta.url).href;

let dictionary = null;
let dictionaryPromise = null;
const deepSeekOverrides = new Map();
const properLemmas = new Set();

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('fr-FR');
}

function sanitizeRussian(value, max = 72) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  // Wiktionary/DBnary annotations occasionally contain a dangling bracket.
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
  return (space > Math.floor(max * 0.58) ? cut.slice(0, space) : text.slice(0, max)).trim();
}

function mapPos(raw) {
  const pos = String(raw || '').trim().toLowerCase();
  if (pos.includes('proper') || pos === 'propn' || pos === 'name') return 'proper_noun';
  if (pos === 'aux' || pos.includes('verb') || pos === 'verbe') return 'verb';
  if (pos.includes('noun') || pos === 'nom' || pos === 'subst') return 'noun';
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
    document.getElementById('reader-chapter-text')?.dataset?.lang ||
    ''
  ).trim().toLowerCase();
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
}

async function loadDictionary() {
  if (dictionary) return dictionary;
  if (dictionaryPromise) return dictionaryPromise;
  dictionaryPromise = fetch(DICT_URL, { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`French core dictionary HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid French core dictionary');
      dictionary = data;
      return data;
    })
    .finally(() => { dictionaryPromise = null; });
  return dictionaryPromise;
}

async function vocabularyData() {
  const loader = globalThis.readerLoadFrenchVocabularyData;
  if (typeof loader !== 'function') return null;
  try { return await loader(); }
  catch (error) {
    console.warn('[fr lexical v2] vocabulary data unavailable', error?.message || error);
    return null;
  }
}

function lemmaFor(surface) {
  const normalized = normalize(surface);
  if (!normalized) return '';
  const override = deepSeekOverrides.get(normalized);
  if (override?.lemma) return override.lemma;
  try {
    const lemma = normalize(globalThis.readerFrenchLemmaFor?.(normalized) || normalized);
    return lemma || normalized;
  } catch {
    return normalized;
  }
}

function entryForLemma(data, lemma) {
  const hit = data?.rankFold?.get?.(normalize(lemma));
  if (!Number.isInteger(hit?.index)) return null;
  return { ...data.entries[hit.index], index: hit.index, rank: hit.index + 1 };
}


function productiveLemma(surface, data) {
  const word = normalize(surface);
  if (!word || !data?.rankFold?.get) return '';
  const candidates = new Set();
  const addStem = (stem) => {
    if (!stem || stem.length < 2) return;
    candidates.add(stem + 'er');
    candidates.add(stem + 'ir');
    candidates.add(stem + 're');
  };

  // Regular present participle / gerund.
  if (word.endsWith('ant') && word.length > 5) addStem(word.slice(0, -3));

  // Imparfait endings: rapportait -> rapporter, sentaient -> sentir.
  for (const ending of ['aient','ions','iez','ais','ait']) {
    if (word.endsWith(ending) && word.length > ending.length + 2) {
      addStem(word.slice(0, -ending.length));
      break;
    }
  }

  // 1st-group passé simple: composa / raccrocha -> composer / raccrocher.
  for (const ending of ['èrent','âmes','âtes','as','a']) {
    if (word.endsWith(ending) && word.length > ending.length + 2) {
      addStem(word.slice(0, -ending.length));
      break;
    }
  }

  // Common -er past participles and their agreement.
  for (const ending of ['ées','ée','és','é']) {
    if (word.endsWith(ending) && word.length > ending.length + 2) {
      candidates.add(word.slice(0, -ending.length) + 'er');
      break;
    }
  }

  const ranked = [];
  for (const candidate of candidates) {
    const hit = data.rankFold.get(normalize(candidate));
    if (Number.isInteger(hit?.index)) ranked.push({ lemma: hit.word || candidate, index: hit.index });
  }
  ranked.sort((a, b) => a.index - b.index);
  return ranked[0]?.lemma || '';
}

function cachedOverride(surface, lemma) {
  return deepSeekOverrides.get(normalize(surface)) || deepSeekOverrides.get(normalize(lemma)) || null;
}

async function analyze(surface) {
  if (currentLang() && currentLang() !== 'fr') return null;
  const normalized = normalize(surface);
  if (!normalized) return null;

  const data = await vocabularyData();
  let lemma = lemmaFor(normalized);
  if (lemma === normalized) {
    const productive = productiveLemma(normalized, data);
    if (productive && productive !== normalized) {
      lemma = productive;
      deepSeekOverrides.set(normalized, { lemma, pos: '', ru: '', gender: '', level: '', isProper: false, t: Date.now(), source: 'productive-morphology' });
      try { window.dispatchEvent(new CustomEvent('reader:fr-lexical-corrected', { detail: { surface: normalized, lemma, source: 'productive-morphology' } })); } catch {}
    }
  }
  const ranked = entryForLemma(data, lemma);
  const override = cachedOverride(normalized, lemma);
  let dict = null;
  try { dict = await loadDictionary(); } catch {}

  const ru = sanitizeRussian(
    override?.ru ||
    dict?.[lemma] ||
    dict?.[normalized] ||
    ''
  );
  const pos = override?.pos || mapPos(ranked?.pos);
  const proper = override?.isProper || properLemmas.has(lemma) || pos === 'proper_noun';

  // A lexical hit means either morphology/rank, a dictionary entry, or a
  // DeepSeek correction from an earlier tap. Do not manufacture local cards
  // for completely unknown capitalized strings.
  if (!ranked && !ru && !override) return null;

  return {
    pos: proper ? 'proper_noun' : pos,
    lemma,
    infinitive: pos === 'verb' ? lemma : '',
    fr: lemma,
    ru,
    meaning: ru,
    gender: override?.gender || '',
    level: override?.level || 'A2',
    rank: ranked?.rank || null,
    _source: override ? 'fr-context-cache' : 'fr-open-lexical',
    _note: ranked
      ? (lemma !== normalized ? `лемма ${lemma} · частотность #${ranked.rank}` : `частотность #${ranked.rank}`)
      : (lemma !== normalized ? `лемма ${lemma}` : 'французский словарь'),
    context_pos: override?.pos || '',
    usage_pos: override?.pos || '',
    isProper: proper,
  };
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
  };
  deepSeekOverrides.set(surface, item);
  // If the AI corrected an inflected surface, make that correction immediately
  // visible to every French layer in this session.
  if (surface !== lemma) deepSeekOverrides.set(`${surface}::lemma`, item);
  if (item.isProper) properLemmas.add(lemma);

  try {
    window.dispatchEvent(new CustomEvent('reader:fr-lexical-corrected', { detail: { surface, ...item } }));
    window.dispatchEvent(new CustomEvent('reader:fr-vocab-ready'));
  } catch {}
}

function overrideLemma(surface) {
  const normalized = normalize(surface);
  const direct = deepSeekOverrides.get(normalized);
  return direct?.lemma || '';
}

function isProper(surface) {
  const normalized = normalize(surface);
  const lemma = overrideLemma(normalized) || lemmaFor(normalized);
  const direct = deepSeekOverrides.get(normalized);
  return !!direct?.isProper || properLemmas.has(lemma);
}

if (typeof window !== 'undefined' && !window.__readerFrLexicalPipelineV2) {
  window.__readerFrLexicalPipelineV2 = true;
  globalThis.readerFrenchLexicalAnalysisFor = analyze;
  globalThis.readerFrenchLexicalOverrideLemmaFor = overrideLemma;
  globalThis.readerFrenchIsProperWord = isProper;
  globalThis.readerFrenchSanitizeRussian = sanitizeRussian;
  document.addEventListener('reader:fr-analysis-ready', (event) => rememberAnalysis(event?.detail || {}));
}

export { normalize, sanitizeRussian, mapPos, analyze, rememberAnalysis, lemmaFor, productiveLemma };

// toc121 — one French lexical pipeline for the word card + reader vocabulary layer.
// It deliberately consumes the same generated Wordhoard/WikDict assets as
// fr-vocab-estimate.js so morphology, rank, POS and inline gloss cannot disagree.
const DICT_URL = new URL('../../../frreader/fr_ru_core.json?v=2', import.meta.url).href;

let dictionary = null;
let dictionaryPromise = null;
const deepSeekOverrides = new Map();
const properLemmas = new Set();
const SAFE_RU_OVERRIDES = new Map([['mec', 'парень']]);

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
  // A standalone ranked headword is normally preserved.  Present participles
  // are the exception only when Wordhoard also contains a dramatically more
  // frequent productive verb candidate (fumant -> fumer).
  const surfaceHit = data.rankFold.get(word);
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
  const best = ranked[0] || null;
  if (!best) return '';
  if (Number.isInteger(surfaceHit?.index)) {
    // A surface that is itself an independently ranked lexical headword owns
    // its global identity. Suffix morphology is not allowed to rename it for
    // every occurrence. Ambiguous usage is resolved only by exact sentence
    // context (e.g. courant stays courant globally, while a particular fumant
    // may be analysed as fumer in its card/inline context).
    // Retired toc122l markers kept only so older static gates recognize the
    // migration: COMMON_LEXICALISED_HEAD_MAX_INDEX = 3000; ratioThreshold; absoluteGap.
    return '';
  }
  return best.lemma || '';
}

function contextParticipleLemma(surface, data) {
  const word = normalize(surface);
  if (!word || !word.endsWith('ant') || word.length <= 5 || !data?.rankFold?.get) return '';
  const stem = word.slice(0, -3);
  const ranked = [];
  for (const candidate of [stem + 'er', stem + 'ir', stem + 're']) {
    const hit = data.rankFold.get(normalize(candidate));
    if (Number.isInteger(hit?.index)) ranked.push({ lemma: hit.word || candidate, index: hit.index });
  }
  ranked.sort((a, b) => a.index - b.index);
  const best = ranked[0] || null;
  const surfaceHit = data.rankFold.get(word);
  if (!best || !Number.isInteger(surfaceHit?.index)) return '';
  // Context is the primary signal. Frequency is only a safety rail against
  // accidentally deriving a rare verb from a common lexical adjective/noun.
  const ceiling = Math.max(2200, Math.floor(surfaceHit.index * 0.65));
  return best.index < ceiling ? (best.lemma || '') : '';
}

function contextSuggestsParticiple(surface, context) {
  const word = normalize(surface);
  if (!word || !word.endsWith('ant')) return false;
  const source = normalize(context);
  if (!source) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // High-confidence written-French frames: a detached participial clause
  // (", fumant ...") or a gerund introduced by en.  We intentionally do not
  // treat every -ant token as verbal: "un plat fumant" stays adjectival.
  const pattern = new RegExp(`(?:^|[,;:]\\s*|\\ben\\s+)${escaped}(?=\\s|[,;:.!?]|$)`, 'iu');
  return pattern.test(source);
}

async function analyzeContext(surface, context = '') {
  if (currentLang() && currentLang() !== 'fr') return null;
  const normalized = normalize(surface);
  if (!normalized) return null;
  const base = await analyze(surface);
  if (!contextSuggestsParticiple(normalized, context)) return base;
  const data = await vocabularyData();
  const contextualLemma = contextParticipleLemma(normalized, data);
  if (!contextualLemma || contextualLemma === normalized) return base;
  const ranked = entryForLemma(data, contextualLemma);
  let dict = null;
  try { dict = await loadDictionary(); } catch {}
  const ru = sanitizeRussian(dict?.[contextualLemma] || base?.ru || '');
  return {
    ...(base || {}),
    pos: 'verb',
    lemma: contextualLemma,
    infinitive: contextualLemma,
    fr: contextualLemma,
    ru,
    meaning: ru,
    level: ranked?.cefr || base?.level || 'A2',
    rank: ranked?.rank || base?.rank || null,
    _source: 'fr-context-morphology',
    _note: `в этом контексте: ${normalized} → ${contextualLemma}`,
    context_pos: 'verb',
    usage_pos: 'verb',
    isProper: false,
  };
}

function cachedOverride(surface, lemma) {
  return deepSeekOverrides.get(normalize(surface)) || deepSeekOverrides.get(normalize(lemma)) || null;
}

async function analyze(surface) {
  if (currentLang() && currentLang() !== 'fr') return null;
  const normalized = normalize(surface);
  if (!normalized) return null;

  const data = await vocabularyData();
  const heuristicProper = chapterProperHeuristic(surface);
  let lemma = heuristicProper ? normalized : lemmaFor(normalized);
  if (lemma === normalized && !heuristicProper) {
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
    SAFE_RU_OVERRIDES.get(normalized) || SAFE_RU_OVERRIDES.get(lemma) ||
    dict?.[lemma] ||
    dict?.[normalized] ||
    ''
  );
  const pos = override?.pos || mapPos(ranked?.pos);
  const proper = isProper(surface) || pos === 'proper_noun';

  // A lexical hit means either morphology/rank, a dictionary entry, or a
  // DeepSeek correction from an earlier tap. Do not manufacture local cards
  // for completely unknown capitalized strings.
  if (!ranked && !ru && !override && !proper) return null;

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
    _source: override ? (override.source || 'fr-analysis-cache') : 'fr-open-lexical',
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
  // Exact-context AI answers belong to that occurrence, not to the global
  // lexical owner for the spelling.  Promoting them globally corrupts genuine
  // homographs (au courant once caused every standalone courant to become
  // courir).  The context-gloss owner consumes the same event/context itself;
  // global overrides are reserved for context-free lexical corrections.
  const exactContext = !!item.context;
  if (!exactContext) {
    deepSeekOverrides.set(surface, item);
    if (surface !== lemma) deepSeekOverrides.set(`${surface}::lemma`, item);
  }
  // Proper-name status is context-independent once positively identified and is
  // safe to share across occurrences; the local chapter heuristic remains the
  // primary path for names that never need AI.
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

function startsWithFrenchUpper(value) {
  return /^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/u.test(String(value || '').trim());
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
  const normalized = normalize(raw);
  const root = document.getElementById('reader-chapter-text');
  if (!root) return false;
  const matches = Array.from(root.querySelectorAll('.reader-word[data-word]')).filter((el) => normalize(el.dataset.word || el.textContent || '') === normalized);
  if (!matches.length) return false;
  let capitals = 0, lowers = 0, nonInitial = 0;
  for (const el of matches) {
    // data-word is normalized by the Reader; textContent preserves book casing.
    const shown = String(el.textContent || el.dataset.word || '').trim();
    if (startsWithFrenchUpper(shown)) capitals += 1; else lowers += 1;
    const before = textBeforeElement(el).trimEnd();
    const sentenceInitial = !before || /[.!?…][\s"'»”)]*$/u.test(before);
    if (startsWithFrenchUpper(shown) && !sentenceInitial) nonInitial += 1;
  }
  // Requiring an actual mid-sentence capital avoids classifying ordinary first
  // words (Le, Personne, Il...) as names.  It also handles demonyms used as a
  // person label (Le Catalan) and dictionary homographs such as Épaulard.
  return capitals > 0 && lowers === 0 && nonInitial > 0;
}

function isProper(surface) {
  const normalized = normalize(surface);
  const direct = deepSeekOverrides.get(normalized);
  if (direct && Object.prototype.hasOwnProperty.call(direct, 'isProper')) return !!direct.isProper;
  const lemma = overrideLemma(normalized) || lemmaFor(normalized);
  return properLemmas.has(lemma) || chapterProperHeuristic(surface);
}

if (typeof window !== 'undefined' && !window.__readerFrLexicalPipelineV2) {
  window.__readerFrLexicalPipelineV2 = true;
  globalThis.readerFrenchLexicalAnalysisFor = analyze;
  globalThis.readerFrenchContextualAnalysisFor = analyzeContext;
  globalThis.readerFrenchLexicalOverrideLemmaFor = overrideLemma;
  globalThis.readerFrenchIsProperWord = isProper;
  globalThis.readerFrenchSanitizeRussian = sanitizeRussian;
  document.addEventListener('reader:fr-analysis-ready', (event) => rememberAnalysis(event?.detail || {}));
}

export { normalize, sanitizeRussian, mapPos, analyze, analyzeContext, rememberAnalysis, lemmaFor, productiveLemma };

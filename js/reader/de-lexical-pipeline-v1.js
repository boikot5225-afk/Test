// German lexical owner for Reader word cards.
//
// Немецкое слово на карточке — это три вещи, которых нет у остальных языков
// читалки: артикль (der/die/das неотделим от существительного), настоящая
// словарная форма с учётом регистра и разбор составного слова. Haustür нет ни
// в одном словаре, но её части есть, и «Haus + Tür» — это и есть ответ.
//
// Источники те же, что у подсветки: собранные на сборке немецкие ресурсы и
// DE→RU WikDict. В французские и испанские слои этот путь не проваливается.
import {
  normalize,
  fold,
  startsUpper,
  vocabularyData,
  lemmaFor,
  genderFor,
  rankFor,
  isNoun,
  compoundParts,
} from './de-vocab-data-v1.js?v=1';

const DICT_URL = new URL('../../../dereader/de_ru_core.json?v=1', import.meta.url).href;
const SENSES_URL = new URL('../../../dereader/de_ru_senses.json?v=1', import.meta.url).href;
const ARTICLES = { m: 'der', f: 'die', n: 'das' };

let dictionary = null;
let senses = null;
let dictionaryPromise = null;
const analysisOverrides = new Map();

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'german' || raw === 'deutsch' || raw === 'de' || raw.startsWith('de-') ? 'de' : raw;
}

export function sanitizeRussian(value, max = 72) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[Ѐ-ԯ]/u.test(text)) return '';
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

export function mapPos(raw) {
  const pos = String(raw || '').trim().toLowerCase();
  if (pos.includes('proper') || pos === 'propn') return 'proper_noun';
  if (pos === 'aux' || pos.includes('verb')) return 'verb';
  if (pos.includes('noun') || pos === 'subst' || pos.includes('substantiv')) return 'noun';
  if (pos.includes('adj')) return 'adjective';
  if (pos.includes('adv')) return 'adverb';
  if (pos.includes('prep') || pos.includes('adp')) return 'preposition';
  if (pos.includes('pron')) return 'pronoun';
  return 'other';
}

async function loadDictionary() {
  if (dictionary) return { core: dictionary, senses };
  if (dictionaryPromise) return dictionaryPromise;
  dictionaryPromise = Promise.all([
    fetch(DICT_URL, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`German core dictionary HTTP ${r.status}`);
      return r.json();
    }),
    fetch(SENSES_URL, { cache: 'force-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([core, extra]) => {
    if (!core || typeof core !== 'object' || Array.isArray(core)) throw new Error('invalid German core dictionary');
    dictionary = core;
    senses = extra && typeof extra === 'object' ? extra : {};
    return { core: dictionary, senses };
  }).finally(() => { dictionaryPromise = null; });
  return dictionaryPromise;
}

function dictionaryHit(core, word) {
  if (!core || !word) return '';
  return core[word] || core[fold(word)] || '';
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

// Заглавная буква в начале предложения не значит ничего, а в середине значит
// существительное. Само слово об этом не говорит, поэтому смотрим, как оно
// стоит в главе: если хоть раз встретилось с заглавной не в начале
// предложения — это существительное.
export function capitalizationInChapter(surface) {
  const wanted = normalize(surface);
  if (!wanted || typeof document === 'undefined') return null;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return null;
  let upperInside = 0;
  let lower = 0;
  let seen = 0;
  for (const el of root.querySelectorAll('.reader-word[data-word]')) {
    const shown = String(el.textContent || el.dataset.word || '').trim();
    if (normalize(shown) !== wanted) continue;
    seen += 1;
    if (!startsUpper(shown)) { lower += 1; continue; }
    const before = textBeforeElement(el).trimEnd();
    if (before && !/[.!?…:;»"']\s*$/u.test(before)) upperInside += 1;
  }
  if (!seen) return null;
  return { upperInside, lower, seen };
}

function readingOptions(surface) {
  const upper = startsUpper(surface);
  const stats = capitalizationInChapter(surface);
  if (!stats) return { capitalized: upper, sentenceInitial: false };
  if (stats.upperInside > 0) return { capitalized: true, sentenceInitial: false };
  // Слово с заглавной встречается только в начале предложений, а где-то стоит
  // и со строчной — значит заглавная здесь ничего не значит.
  if (upper && stats.lower > 0) return { capitalized: true, sentenceInitial: true };
  return { capitalized: upper, sentenceInitial: upper };
}

export async function lemmaOf(surface) {
  const data = await vocabularyData().catch(() => null);
  if (!data) return normalize(surface);
  const override = analysisOverrides.get(normalize(surface));
  if (override?.lemma) return override.lemma;
  return lemmaFor(data, surface, readingOptions(surface));
}

// Составное существительное: перевода целого слова в словаре нет, но части
// известны. Склеиваем их значения — это ровно то, что немец делает в уме.
export function compoundGloss(data, core, word) {
  const parts = compoundParts(data, word);
  if (!parts || parts.length < 2) return null;
  const glosses = parts.map(part => sanitizeRussian(dictionaryHit(core, part), 28));
  if (glosses.some(item => !item)) return { parts, ru: '' };
  return { parts, ru: glosses.join(' + ') };
}

export async function analyze(surface) {
  const lang = currentLang();
  if (lang && lang !== 'de') return null;
  const raw = String(surface || '').trim();
  const word = normalize(raw);
  if (!word) return null;

  const data = await vocabularyData().catch(() => null);
  const lemma = data ? lemmaFor(data, raw, readingOptions(raw)) : word;
  let core = null;
  let extra = null;
  try {
    const loaded = await loadDictionary();
    core = loaded.core;
    extra = loaded.senses;
  } catch (error) {
    console.warn('[de lexical v1] dictionary unavailable', error?.message || error);
  }

  const override = analysisOverrides.get(word) || analysisOverrides.get(normalize(lemma)) || null;
  let ru = sanitizeRussian(override?.ru || dictionaryHit(core, lemma) || dictionaryHit(core, word));
  const noun = data ? isNoun(data, lemma) : false;
  const gender = override?.gender || (data ? genderFor(data, lemma) : '');
  const rank = data ? rankFor(data, lemma) : null;

  let compound = null;
  if (!ru && data) {
    compound = compoundGloss(data, core, lemma);
    if (compound?.ru) ru = compound.ru;
  }
  if (!ru && !rank && !override && !compound) return null;

  const pos = override?.pos || (noun ? 'noun' : '');
  const article = gender ? ARTICLES[gender] || '' : '';
  const notes = [];
  if (article) notes.push(`${article} ${raw.charAt(0).toUpperCase()}${lemma.slice(1)}`);
  else if (lemma !== word) notes.push(`лемма ${lemma}`);
  if (compound?.parts?.length > 1) notes.push(`состав: ${compound.parts.join(' + ')}`);
  if (rank) notes.push(`частотность #${rank}`);

  return {
    pos: pos || 'other',
    lemma,
    de: lemma,
    ru,
    meaning: ru,
    gender,
    article,
    parts: compound?.parts || null,
    senses: (extra && (extra[lemma] || extra[fold(lemma)])) || null,
    level: override?.level || 'A2',
    rank: rank || null,
    _source: override ? (override.source || 'de-analysis-cache') : 'de-open-lexical',
    _note: notes.join(' · ') || 'немецкий словарь',
    isProper: !!override?.isProper,
  };
}

export async function analyzeContext(surface, context = '') {
  const base = await analyze(surface);
  if (!base) return null;
  return { ...base, context: String(context || '').trim(), _source: base._source || 'de-open-lexical' };
}

export function rememberAnalysis(detail = {}) {
  const surface = normalize(detail.surface || detail.word || '');
  const lemma = normalize(detail.lemma || surface);
  if (!surface || !lemma) return;
  const item = {
    lemma,
    pos: mapPos(detail.context_pos || detail.usage_pos || detail.pos || ''),
    ru: sanitizeRussian(detail.ru || detail.translation || detail.meaning || ''),
    gender: String(detail.gender || '').trim().toLowerCase(),
    level: String(detail.level || '').trim(),
    isProper: !!detail.isProper,
    context: String(detail.context || '').trim(),
    t: Date.now(),
    source: String(detail.source || 'de-analysis').trim(),
  };
  // Контекстное значение принадлежит одному месту в тексте: Bank — это и
  // скамейка, и банк, и подменять этим весь словарь нельзя.
  if (!item.context) analysisOverrides.set(surface, item);
  try {
    window.dispatchEvent(new CustomEvent('reader:de-lexical-corrected', { detail: { surface, ...item } }));
  } catch {}
}

if (typeof window !== 'undefined' && !window.__readerDeLexicalPipelineV1) {
  window.__readerDeLexicalPipelineV1 = true;
  globalThis.readerGermanLexicalAnalysisFor = analyze;
  globalThis.readerGermanContextualAnalysisFor = analyzeContext;
  globalThis.readerGermanSanitizeRussian = sanitizeRussian;
  document.addEventListener('reader:de-analysis-ready', event => rememberAnalysis(event?.detail || {}));
}

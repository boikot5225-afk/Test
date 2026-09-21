// German vocabulary data for the Reader.
//
// Немецкий отличается от остальных языков читалки одним: заглавная буква —
// это часть слова. Lampe и lampen, Stunden и stunden, Gute и gut — разные
// слова, и различает их регистр на странице. Поэтому словарь приезжает двумя
// картами, и спрашивать их надо по-разному:
//
//   de_noun_lemma.tsv   форма -> существительное, из таблиц склонений
//                       Викисловаря. Для слова с заглавной: Stunden -> Stunde.
//   de_vocab_lemma.tsv  форма -> лемма от simplemma. Для строчного слова:
//                       habe -> haben, ging -> gehen, gute -> gut.
//
// Заглавная в начале предложения ничего не значит, поэтому у неё отдельный
// путь: там сначала спрашивается существительное, а если его нет — общая
// карта. Слово в середине предложения с заглавной — почти наверняка
// существительное, и оно спрашивается только как существительное.
const BASE = '../../../dereader/';
const FREQUENCY_URL = new URL(`${BASE}de_vocab_frequency.tsv?v=1`, import.meta.url).href;
const GENERAL_URL = new URL(`${BASE}de_vocab_lemma.tsv?v=1`, import.meta.url).href;
const NOUN_URL = new URL(`${BASE}de_noun_lemma.tsv?v=1`, import.meta.url).href;
const GENDER_URL = new URL(`${BASE}de_noun_gender.tsv?v=1`, import.meta.url).href;

// Те же числа, что в scripts/build_de_reader_resources.py: разбор на телефоне
// обязан давать ровно то же, что проверено на сборке.
const MIN_PART = 3;
const FUGEN = ['', 's', 'es', 'n', 'en', 'er', 'e'];
const MAX_PARTS = 3;

let data = null;
let dataPromise = null;

export function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLowerCase();
}

// wordfreq сворачивает ß в ss, и частотный список знает только strasse. Слова
// из таблиц склонений приезжают с настоящим написанием, но книга может быть
// набрана и по-швейцарски, поэтому спрашиваем оба варианта.
export function fold(value) {
  return String(value || '').replace(/ß/g, 'ss');
}

export function startsUpper(value) {
  const first = String(value || '').trim().charAt(0);
  return !!first && first !== first.toLowerCase() && first === first.toUpperCase();
}

function parsePairs(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab);
    const value = line.slice(tab + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

function parseFrequency(text) {
  const rank = new Map();
  const nouns = new Set();
  const names = new Set();
  let index = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const word = tab < 0 ? line.trim() : line.slice(0, tab);
    if (!word) continue;
    if (!rank.has(word)) rank.set(word, index);
    const kind = tab >= 0 ? line.slice(tab + 1).trim() : '';
    if (kind === 'NOUN') nouns.add(word);
    else if (kind === 'NAME') names.add(word);
    index += 1;
  }
  return { rank, nouns, names };
}

async function fetchText(url, label) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.text();
}

export async function vocabularyData() {
  if (data) return data;
  if (dataPromise) return dataPromise;
  dataPromise = Promise.all([
    fetchText(FREQUENCY_URL, 'German frequency'),
    fetchText(GENERAL_URL, 'German lemma map'),
    fetchText(NOUN_URL, 'German noun map'),
    fetchText(GENDER_URL, 'German gender map'),
  ]).then(([frequency, general, noun, gender]) => {
    const parsed = parseFrequency(frequency);
    data = {
      rank: parsed.rank,
      nouns: parsed.nouns,
      names: parsed.names,
      general: parsePairs(general),
      noun: parsePairs(noun),
      gender: parsePairs(gender),
    };
    return data;
  }).finally(() => { dataPromise = null; });
  return dataPromise;
}

export function buildData({ frequency = '', general = '', noun = '', gender = '' } = {}) {
  const parsed = parseFrequency(frequency);
  return {
    rank: parsed.rank,
    nouns: parsed.nouns,
    names: parsed.names,
    general: parsePairs(general),
    noun: parsePairs(noun),
    gender: parsePairs(gender),
  };
}

function known(source, word) {
  if (!word) return '';
  const direct = source.get(word);
  if (direct) return direct;
  const folded = source.get(fold(word));
  return folded || '';
}

function ranked(source, word) {
  if (!word) return '';
  if (source.rank.has(word)) return word;
  const folded = fold(word);
  return source.rank.has(folded) ? folded : '';
}

// Лемма немецкой формы. Регистр слова на странице — это не оформление, а
// грамматика, поэтому его передают сюда как есть.
export function lemmaFor(source, surface, { capitalized = null, sentenceInitial = false } = {}) {
  if (!source) return '';
  const raw = String(surface || '').trim();
  const word = normalize(raw);
  if (!word) return '';
  const upper = capitalized == null ? startsUpper(raw) : !!capitalized;
  const asNoun = known(source.noun, word);
  const asGeneral = known(source.general, word);

  if (upper && !sentenceInitial) {
    // Заглавная в середине предложения — существительное, и ничем другим она
    // быть не может.
    if (asNoun) return asNoun;
    if (ranked(source, word)) return ranked(source, word);
    return asGeneral || word;
  }
  if (upper) {
    // Начало предложения: заглавная ничего не говорит, но существительное
    // всё-таки вероятнее — с него и начинаем.
    if (asNoun) return asNoun;
    if (asGeneral) return asGeneral;
    return ranked(source, word) || word;
  }
  if (asGeneral) return asGeneral;
  if (ranked(source, word)) return ranked(source, word);
  return asNoun || word;
}

// Лемма без подсказки о регистре. Словарный тест и подсветка спрашивают уже
// приведённое к нижнему регистру слово — заглавной буквы там нет. Тогда обе
// карты равноправны, и выбирает частотность: strassen — это Straße (325-е
// слово), а не редкий Strass; haus — это дом, а не глагол hausen; habe — это
// всё-таки haben, который частотнее существительного Habe.
export function mergedLemma(source, surface) {
  if (!source) return '';
  const word = normalize(surface);
  if (!word) return '';
  const candidates = [known(source.general, word), known(source.noun, word), ranked(source, word)];
  let best = '';
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const rank = source.rank.get(candidate);
    if (rank == null || rank >= bestRank) continue;
    best = candidate;
    bestRank = rank;
  }
  return best && best !== word ? best : '';
}

export function genderFor(source, lemma) {
  if (!source) return '';
  const word = normalize(lemma);
  return source.gender.get(word) || source.gender.get(fold(word)) || '';
}

export function rankFor(source, lemma) {
  if (!source) return null;
  const word = ranked(source, normalize(lemma));
  if (!word) return null;
  return source.rank.get(word) + 1;
}

// Имя собственное по данным Викисловаря: у слова есть только имя, фамилия
// или топоним и нет нарицательного значения.
export function isName(source, lemma) {
  if (!source?.names) return false;
  const word = ranked(source, normalize(lemma));
  return !!word && source.names.has(word);
}

export function isNoun(source, lemma) {
  if (!source) return false;
  const word = ranked(source, normalize(lemma));
  return !!word && source.nouns.has(word);
}

function resolvePart(source, part) {
  const direct = ranked(source, part);
  if (direct) return direct;
  const lemma = known(source.noun, part);
  return lemma && source.rank.has(lemma) ? lemma : '';
}

function splitsOf(source, rest, depth, whole) {
  const out = [];
  if (!whole) {
    const single = resolvePart(source, rest);
    if (single) out.push([single]);
  }
  if (depth > 1 && rest.length >= MIN_PART * 2) {
    for (let cut = MIN_PART; cut <= rest.length - MIN_PART; cut += 1) {
      const head = rest.slice(0, cut);
      const last = resolvePart(source, rest.slice(cut));
      if (!last) continue;
      const stems = new Set();
      for (const link of FUGEN) {
        if (link && !head.endsWith(link)) continue;
        const stem = link ? head.slice(0, head.length - link.length) : head;
        if (stem.length < MIN_PART || stems.has(stem)) continue;
        stems.add(stem);
        for (const left of splitsOf(source, stem, depth - 1, false)) out.push([...left, last]);
      }
    }
  }
  return out;
}

// Составное слово раскладывается на самые крупные известные части, а при
// равенстве — на самые частотные: Bahnhofstraße — это Bahnhof и Straße, а не
// Bahn, Hof и Straße, и не набор из трёхбуквенных обрывков, которых в списке на
// шестьдесят тысяч слов хватает.
export function compoundParts(source, word) {
  if (!source) return null;
  const value = normalize(word);
  if (value.length < MIN_PART * 2) return null;
  const variants = splitsOf(source, value, MAX_PARTS, true);
  if (!variants.length) return null;
  let best = null;
  let bestCost = null;
  for (const parts of variants) {
    let max = -1;
    let sum = 0;
    for (const part of parts) {
      const rank = source.rank.get(part) ?? Number.MAX_SAFE_INTEGER;
      if (rank > max) max = rank;
      sum += rank;
    }
    const cost = [parts.length, max, sum];
    if (!bestCost || cost[0] < bestCost[0]
      || (cost[0] === bestCost[0] && cost[1] < bestCost[1])
      || (cost[0] === bestCost[0] && cost[1] === bestCost[1] && cost[2] < bestCost[2])) {
      best = parts;
      bestCost = cost;
    }
  }
  return best;
}

if (typeof window !== 'undefined' && !window.__readerDeVocabDataV1) {
  window.__readerDeVocabDataV1 = true;
  globalThis.readerLoadGermanVocabularyData = vocabularyData;
  globalThis.readerGermanLemmaFor = (surface, options) => {
    if (!data) { vocabularyData().catch(() => {}); return normalize(surface); }
    return lemmaFor(data, surface, options || {});
  };
  globalThis.readerGermanCompoundParts = word => (data ? compoundParts(data, word) : null);
  // Крючок словарного теста: он отдаёт слово уже строчным, и сюда приходит
  // форма без регистра. Пустая строка означает «не знаю» — тест тогда идёт
  // своим путём, а не получает выдуманный ответ.
  globalThis.readerGermanLexicalOverrideLemmaFor = surface => {
    if (!data) { vocabularyData().catch(() => {}); return ''; }
    return mergedLemma(data, surface);
  };
  globalThis.readerGermanGenderFor = lemma => (data ? genderFor(data, lemma) : '');
}

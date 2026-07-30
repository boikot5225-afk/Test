// Local Japanese dictionary: JMdict compacted into data/ja_dict_core.json.
//
// Japanese needs one more layer than Chinese does. A Chinese token appears in
// CC-CEDICT exactly as it is written, so a map lookup is the whole story. A
// Japanese verb almost never does: the text says 読んだ while the dictionary
// knows 読む. So every lookup runs the surface form back through the inflection
// rules below until something in the dictionary matches — and because a rule
// only counts when the candidate exists AND its part of speech is the one the
// rule expects, wrong guesses fall away on their own (読める resolves to 読む,
// while 食べる is never mistaken for a potential form of a verb 食ぶ that does
// not exist).

// [inflected ending, dictionary ending, part of speech the result must have,
//  what the surface form is, in Russian]
// Order does not matter; every rule that applies is tried and validated.
const DEINFLECT_RULES = [
  // て-form and plain past. Which godan verb a tail belongs to is ambiguous
  // (んだ fits 死ぬ, 遊ぶ and 読む alike), so all candidates are generated and
  // the dictionary picks the winner.
  // 行く first: 行った is both 行く (いった) and 行う (おこなった) on paper, and
  // the first validated rule wins. v5k-s is a three-verb class, so trying it
  // ahead of the generic った never steals a form from anything else.
  ['って', 'く', 'v5k-s', 'て-форма'], ['った', 'く', 'v5k-s', 'прошедшее'],
  ['って', 'う', 'v5u', 'て-форма'], ['って', 'つ', 'v5t', 'て-форма'], ['って', 'る', 'v5r', 'て-форма'],
  ['った', 'う', 'v5u', 'прошедшее'], ['った', 'つ', 'v5t', 'прошедшее'], ['った', 'る', 'v5r', 'прошедшее'],
  ['いて', 'く', 'v5k', 'て-форма'], ['いた', 'く', 'v5k', 'прошедшее'],
  ['いで', 'ぐ', 'v5g', 'て-форма'], ['いだ', 'ぐ', 'v5g', 'прошедшее'],
  ['して', 'す', 'v5s', 'て-форма'], ['した', 'す', 'v5s', 'прошедшее'],
  ['して', 'する', 'vs', 'て-форма'], ['した', 'する', 'vs', 'прошедшее'],
  ['んで', 'ぬ', 'v5n', 'て-форма'], ['んで', 'ぶ', 'v5b', 'て-форма'], ['んで', 'む', 'v5m', 'て-форма'],
  ['んだ', 'ぬ', 'v5n', 'прошедшее'], ['んだ', 'ぶ', 'v5b', 'прошедшее'], ['んだ', 'む', 'v5m', 'прошедшее'],
  // 来る written in kanji keeps the stem hidden: 来た has no き to strip, so it
  // needs the same rules as an ichidan verb, told apart by the vk part of speech.
  ['きて', 'くる', 'vk', 'て-форма'], ['きた', 'くる', 'vk', 'прошедшее'],
  ['て', 'る', 'vk', 'て-форма'], ['た', 'る', 'vk', 'прошедшее'],
  ['ます', 'る', 'vk', 'вежливая форма'], ['ない', 'る', 'vk', 'отрицание'],
  ['て', 'る', 'v1', 'て-форма'], ['た', 'る', 'v1', 'прошедшее'],

  // Polite ます-forms.
  ['きます', 'く', 'v5k', 'вежливая форма'], ['ぎます', 'ぐ', 'v5g', 'вежливая форма'],
  ['します', 'す', 'v5s', 'вежливая форма'], ['します', 'する', 'vs', 'вежливая форма'],
  ['ちます', 'つ', 'v5t', 'вежливая форма'], ['にます', 'ぬ', 'v5n', 'вежливая форма'],
  ['びます', 'ぶ', 'v5b', 'вежливая форма'], ['みます', 'む', 'v5m', 'вежливая форма'],
  ['ります', 'る', 'v5r', 'вежливая форма'], ['います', 'う', 'v5u', 'вежливая форма'],
  ['きます', 'くる', 'vk', 'вежливая форма'], ['ます', 'る', 'v1', 'вежливая форма'],

  // Plain negative.
  ['かない', 'く', 'v5k', 'отрицание'], ['がない', 'ぐ', 'v5g', 'отрицание'],
  ['さない', 'す', 'v5s', 'отрицание'], ['たない', 'つ', 'v5t', 'отрицание'],
  ['なない', 'ぬ', 'v5n', 'отрицание'], ['ばない', 'ぶ', 'v5b', 'отрицание'],
  ['まない', 'む', 'v5m', 'отрицание'], ['らない', 'る', 'v5r', 'отрицание'],
  ['わない', 'う', 'v5u', 'отрицание'], ['しない', 'する', 'vs', 'отрицание'],
  ['こない', 'くる', 'vk', 'отрицание'], ['ない', 'る', 'v1', 'отрицание'],

  // Potential. These deliberately overlap with real ichidan verbs; validation
  // against the dictionary is what separates 読める from 食べる.
  ['ける', 'く', 'v5k', 'потенциальная форма'], ['げる', 'ぐ', 'v5g', 'потенциальная форма'],
  ['せる', 'す', 'v5s', 'потенциальная форма'], ['てる', 'つ', 'v5t', 'потенциальная форма'],
  ['ねる', 'ぬ', 'v5n', 'потенциальная форма'], ['べる', 'ぶ', 'v5b', 'потенциальная форма'],
  ['める', 'む', 'v5m', 'потенциальная форма'], ['れる', 'る', 'v5r', 'потенциальная форма'],
  ['える', 'う', 'v5u', 'потенциальная форма'], ['られる', 'る', 'v1', 'потенциальная/пассив'],

  // Volitional and imperative.
  ['こう', 'く', 'v5k', 'волитив'], ['ごう', 'ぐ', 'v5g', 'волитив'], ['そう', 'す', 'v5s', 'волитив'],
  ['とう', 'つ', 'v5t', 'волитив'], ['のう', 'ぬ', 'v5n', 'волитив'], ['ぼう', 'ぶ', 'v5b', 'волитив'],
  ['もう', 'む', 'v5m', 'волитив'], ['ろう', 'る', 'v5r', 'волитив'], ['おう', 'う', 'v5u', 'волитив'],
  ['よう', 'る', 'v1', 'волитив'],

  // い-adjectives.
  ['くて', 'い', 'adj-i', 'て-форма'], ['かった', 'い', 'adj-i', 'прошедшее'],
  ['くない', 'い', 'adj-i', 'отрицание'], ['く', 'い', 'adj-i', 'наречная форма'],
  ['ければ', 'い', 'adj-i', 'условная форма'],

  // する-nouns. JMdict stores 勉強, not 勉強する, so the whole する tail comes
  // off and the noun itself has to be marked vs for the rule to count.
  ['する', '', 'vs', 'словарная форма'], ['して', '', 'vs', 'て-форма'],
  ['した', '', 'vs', 'прошедшее'], ['します', '', 'vs', 'вежливая форма'],
  ['しない', '', 'vs', 'отрицание'], ['できる', '', 'vs', 'потенциальная форма'],

  // Chains: these rewrite one ending into another and let the next pass finish
  // the job, so 読まなかった walks 読まない → 読む in two steps.
  ['なかった', 'ない', '', 'отрицание в прошедшем'],
  ['ました', 'ます', '', 'вежливое прошедшее'],
  ['ませんでした', 'ます', '', 'вежливое отрицание в прошедшем'],
  ['ません', 'ます', '', 'вежливое отрицание'],
  ['ている', 'て', '', 'длительный вид'], ['ていた', 'て', '', 'длительный вид в прошедшем'],
  ['てる', 'て', '', 'длительный вид'], ['てい', 'て', '', 'длительный вид'],
  ['ています', 'て', '', 'длительный вид, вежливо'],
  // After ん the て of a continuous form voices to で — 読んでいる, not
  // 読んている — so the same chains need their で spelling too.
  ['でいる', 'で', '', 'длительный вид'], ['でいた', 'で', '', 'длительный вид в прошедшем'],
  ['でる', 'で', '', 'длительный вид'], ['でい', 'で', '', 'длительный вид'],
  ['でいます', 'で', '', 'длительный вид, вежливо'],
  ['たい', 'る', 'v1', 'желательная форма'],
  ['きたい', 'く', 'v5k', 'желательная форма'], ['みたい', 'む', 'v5m', 'желательная форма'],
  ['りたい', 'る', 'v5r', 'желательная форма'], ['いたい', 'う', 'v5u', 'желательная форма'],
  ['したい', 'する', 'vs', 'желательная форма'],
];

const MAX_DEINFLECT_DEPTH = 4;
const KANA = /[぀-ヿ]/;

function isKana(ch) {
  return KANA.test(ch);
}

// JMdict's conjugation classes are what the deinflector needs, but the word
// panel speaks in plain part-of-speech names. Keep both.
const POS_LABELS = Object.freeze({
  v5k: 'verb', 'v5k-s': 'verb', v5g: 'verb', v5s: 'verb', v5t: 'verb', v5n: 'verb',
  v5b: 'verb', v5m: 'verb', v5r: 'verb', v5u: 'verb', v1: 'verb', vk: 'verb', vs: 'verb',
  'adj-i': 'i_adjective', 'adj-na': 'na_adjective', n: 'noun', adv: 'adverb',
  prt: 'particle', ctr: 'counter', pn: 'pronoun', conj: 'conjunction', int: 'interjection',
  pref: 'prefix', suf: 'suffix', exp: 'other',
});

// 読んだ should get よんだ over it, not the dictionary's よむ. The lemma and its
// reading share a kana tail (読む / よむ), so peeling that tail off both leaves
// the kanji stem 読 paired with its reading よ — and the surface form's own tail
// can then be appended.
// 来る is the one verb whose kanji changes reading as it conjugates — く / き /
// こ — so peeling a stem off it gives くた for 来た. It is a closed list, so it
// is simply written out.
const IRREGULAR_READINGS = Object.freeze({
  '来る': 'くる', '来': 'く', '来ます': 'きます', '来ました': 'きました', '来た': 'きた',
  '来て': 'きて', '来ている': 'きている', '来ない': 'こない', '来なかった': 'こなかった',
  '来られる': 'こられる', '来させる': 'こさせる', '来れば': 'くれば', '来い': 'こい',
});

export function surfaceReading(surface, lemma, lemmaReading) {
  if (IRREGULAR_READINGS[surface]) return IRREGULAR_READINGS[surface];
  if (!surface || !lemma || !lemmaReading) return '';
  let shared = 0;
  while (
    shared < lemma.length && shared < lemmaReading.length &&
    lemma[lemma.length - 1 - shared] === lemmaReading[lemmaReading.length - 1 - shared] &&
    isKana(lemma[lemma.length - 1 - shared])
  ) shared++;
  const stem = lemma.slice(0, lemma.length - shared);
  const stemReading = lemmaReading.slice(0, lemmaReading.length - shared);
  if (!stem || !surface.startsWith(stem)) return '';
  return stemReading + surface.slice(stem.length);
}

export function createJapaneseDictionary({ url, log = console }) {
  let map = null;
  let loading = null;

  function isLoaded() { return !!map; }
  function needsLoad() { return !map && !loading; }
  function count() { return map ? Object.keys(map).length : 0; }

  function ensureLoaded(options = {}) {
    if (map) return Promise.resolve(map);
    if (loading) return loading;
    loading = fetch(url, { cache: 'force-cache' })
      .then(res => {
        if (!res.ok) throw new Error('ja_dict_core.json HTTP ' + res.status);
        return res.json();
      })
      .then(payload => {
        map = Object.freeze(payload?.map || {});
        options.onLoaded?.(count(), payload?.version || 'unknown');
        return map;
      })
      .catch(error => {
        log.warn?.('[ja core json] load failed:', error?.message || error);
        map = Object.freeze({});
        return map;
      });
    return loading;
  }

  function raw(word) {
    if (!map || !word) return null;
    const row = map[word];
    return Array.isArray(row) ? row : null;
  }

  function entryFor(word, surface, formNote) {
    const row = raw(word);
    if (!row) return null;
    const [reading, pos, en] = row;
    // A kana headword stores no reading because the key already is one.
    const lemmaReading = reading || word;
    return {
      lang: 'ja',
      word,
      lemma: word,
      surface: surface || word,
      reading: surfaceReading(surface || word, word, lemmaReading) || lemmaReading,
      lemmaReading,
      pos: POS_LABELS[pos] || '',
      posCode: pos || '',
      en: en || '',
      english: en || '',
      form_note: formNote || '',
      level: 'JMdict',
      _source: 'jmdict-local',
      _note: 'локальный JMdict / data/ja_dict_core.json',
    };
  }

  // Walks the rule table, breadth first, until a candidate is in the dictionary
  // with the part of speech its rule promised. Depth is capped because chained
  // rules (読まなかった → 読まない → 読む) can otherwise loop on each other.
  function deinflect(surface) {
    const seen = new Set([surface]);
    let frontier = [{ form: surface, note: '' }];
    for (let depth = 0; depth < MAX_DEINFLECT_DEPTH; depth++) {
      const next = [];
      for (const { form, note } of frontier) {
        for (const [from, to, requiredPos, formName] of DEINFLECT_RULES) {
          if (!form.endsWith(from) || form.length - from.length + to.length < 2) continue;
          const candidate = form.slice(0, form.length - from.length) + to;
          const row = raw(candidate);
          // Validate before deduping: several rules propose the same candidate
          // while demanding different parts of speech (食べた is reached by both
          // the vk and the ichidan rule), and only one of them is right.
          if (row && (!requiredPos || row[1] === requiredPos)) {
            return { lemma: candidate, note: note || formName };
          }
          if (seen.has(candidate)) continue;
          seen.add(candidate);
          next.push({ form: candidate, note: note || formName });
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    return null;
  }

  function lookup(surface) {
    const word = String(surface || '').trim();
    if (!word || !map) return null;
    const direct = entryFor(word, word, '');
    if (direct) return direct;
    const found = deinflect(word);
    return found ? entryFor(found.lemma, word, found.note) : null;
  }

  function readingOf(surface) {
    return lookup(surface)?.reading || '';
  }

  return { ensureLoaded, isLoaded, needsLoad, count, lookup, readingOf };
}

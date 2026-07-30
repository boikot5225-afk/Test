// Builds data/ja_dict_core.json — the local Japanese dictionary the reader uses
// for furigana, dictionary forms and instant lookups, the way
// data/zh_dict_core.json does for Chinese.
//
// Source: JMdict (Electronic Dictionary Research and Development Group),
// taken from the `jamdict-data` PyPI package, which ships JMdict + KANJIDIC2 as
// one SQLite database. To regenerate:
//
//   pip download jamdict-data==1.5 --no-deps -d /tmp/jam
//   tar xzf /tmp/jam/jamdict_data-1.5.tar.gz -C /tmp/jam
//   xz -dk /tmp/jam/jamdict_data-1.5/jamdict_data/jamdict.db.xz
//   node scripts/make-ja-dict.mjs /tmp/jam/jamdict_data-1.5/jamdict_data/jamdict.db
//
// What goes in, and why not everything: the file is keyed by the forms that
// actually need a local answer. Every kanji form is included, because those are
// the ones needing furigana and the ones a reader cannot sound out. Kana-only
// forms are included only for verbs and adjectives, because the deinflector has
// to resolve ない / いる / する chains that are written in kana. Kana-only nouns
// are left out — they already spell their own reading, and their meaning comes
// from DeepSeek like any other uncached word. That keeps the file in the same
// weight class as the Chinese one instead of doubling it.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node scripts/make-ja-dict.mjs <path to jamdict.db>');
  process.exit(1);
}

// JMdict spells parts of speech out in full ("Godan verb with 'mu' ending").
// The reader only needs enough to conjugate, so collapse them to the short
// codes the deinflector switches on. Order matters: the first match wins.
const POS_CODES = [
  [/^Godan verb - Iku\/Yuku/i, 'v5k-s'],
  [/^Godan verb - -aru/i, 'v5r'],
  [/^Godan verb .*'ku' ending/i, 'v5k'],
  [/^Godan verb .*'gu' ending/i, 'v5g'],
  [/^Godan verb .*'su' ending/i, 'v5s'],
  [/^Godan verb .*'tsu' ending/i, 'v5t'],
  [/^Godan verb .*'nu' ending/i, 'v5n'],
  [/^Godan verb .*'bu' ending/i, 'v5b'],
  [/^Godan verb .*'mu' ending/i, 'v5m'],
  [/^Godan verb .*'ru' ending/i, 'v5r'],
  [/^Godan verb .*'u' ending/i, 'v5u'],
  [/^Ichidan verb/i, 'v1'],
  [/^Kuru verb/i, 'vk'],
  [/^suru verb/i, 'vs'],
  [/aux\. verb suru/i, 'vs'],
  [/^adjective \(keiyoushi\)/i, 'adj-i'],
  [/^adjectival nouns/i, 'adj-na'],
  [/^adverb/i, 'adv'],
  [/^particle/i, 'prt'],
  [/^counter/i, 'ctr'],
  [/^conjunction/i, 'conj'],
  [/^interjection/i, 'int'],
  [/^pronoun/i, 'pn'],
  [/^prefix/i, 'pref'],
  [/^suffix/i, 'suf'],
  [/^expressions/i, 'exp'],
  [/^noun/i, 'n'],
];
const INFLECTABLE = new Set(['v5k', 'v5k-s', 'v5g', 'v5s', 'v5t', 'v5n', 'v5b', 'v5m', 'v5r', 'v5u', 'v1', 'vk', 'vs', 'adj-i']);
const GLOSS_MAX = 60;

function posCode(text) {
  for (const [pattern, code] of POS_CODES) if (pattern.test(text)) return code;
  return '';
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql) => db.prepare(sql).all();

// One sense per entry is enough: the first is JMdict's primary meaning.
const firstSense = new Map();
for (const r of rows('select idseq, min(ID) as sid from Sense group by idseq')) firstSense.set(r.idseq, r.sid);

const gloss = new Map();
for (const r of rows("select sid, text from SenseGloss where lang is null or lang in ('eng','')")) {
  if (!gloss.has(r.sid)) gloss.set(r.sid, r.text);
}

// A sense carries several pos rows and their order is not helpful: 行く lists
// "transitive verb" alongside its conjugation class. The conjugation class is
// the one the deinflector needs, so it always wins over the generic labels.
const pos = new Map();
for (const r of rows('select sid, text from pos')) {
  const code = posCode(r.text);
  if (!code) continue;
  const held = pos.get(r.sid);
  if (held && (INFLECTABLE.has(held) || !INFLECTABLE.has(code))) continue;
  pos.set(r.sid, code);
}

const kanjiForms = new Map();
for (const r of rows('select idseq, text from Kanji')) {
  if (!kanjiForms.has(r.idseq)) kanjiForms.set(r.idseq, []);
  kanjiForms.get(r.idseq).push(r.text);
}
const kanaForms = new Map();
for (const r of rows('select idseq, text from Kana')) {
  if (!kanaForms.has(r.idseq)) kanaForms.set(r.idseq, []);
  kanaForms.get(r.idseq).push(r.text);
}

// Homographs make claiming a key first-come-first-served wrong: 本 belongs to
// ほん "book", but the 元/本/素 (もと, "origin") entry has a lower sequence
// number and would take it, and ない would resolve to 亡い "dead" rather than
// 無い. JMdict carries no frequency field here, so two signals stand in for it.
// First, a form that heads its own entry outranks the same form listed as a
// variant of another word. Second, among headwords, the entry with more senses
// wins — the everyday word is the one that accumulated meanings.
const senseCount = new Map();
for (const r of rows('select idseq, count(*) as n from Sense group by idseq')) senseCount.set(r.idseq, r.n);

const map = {};
const headwordScore = new Map();

function claim(form, value, score) {
  if (score === null) {
    if (form in map) return false;
    map[form] = value;
    return true;
  }
  const held = headwordScore.get(form);
  if (held !== undefined && held >= score) return false;
  map[form] = value;
  headwordScore.set(form, score);
  return held === undefined;
}

for (const pass of ['headword', 'variant']) {
  for (const r of rows('select idseq from Entry')) {
    const sid = firstSense.get(r.idseq);
    const code = pos.get(sid) || '';
    const meaning = (gloss.get(sid) || '').slice(0, GLOSS_MAX);
    const readings = kanaForms.get(r.idseq) || [];
    const reading = readings[0] || '';
    const kanji = kanjiForms.get(r.idseq) || [];
    const score = pass === 'headword' ? (senseCount.get(r.idseq) || 1) : null;
    const kanjiPass = pass === 'headword' ? kanji.slice(0, 1) : kanji.slice(1);
    // Kana headwords only earn their bytes when the deinflector needs them.
    const kanaPass = !INFLECTABLE.has(code) ? []
      : pass === 'headword' ? readings.slice(0, 1) : readings.slice(1);

    for (const form of kanjiPass) claim(form, [reading, code, meaning], score);
    for (const form of kanaPass) claim(form, ['', code, meaning], score);
  }
}

const payload = {
  version: '77.33-jmdict-via-jamdict-data-1.5',
  format: 'an2-ja-core-v1-compact-map',
  source: 'JMdict (EDRDG), packaged by jamdict-data 1.5 on PyPI',
  license: 'Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)',
  license_url: 'https://www.edrdg.org/edrdg/licence.html',
  note: 'Compact local dictionary for readings, dictionary forms and lookups. Values are [kana_reading, pos_code, english_gloss]; an empty reading means the key is already kana. Russian explanations are produced and cached separately by DeepSeek.',
  entry_count: Object.keys(map).length,
  map,
};

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/ja_dict_core.json', JSON.stringify(payload));
console.log(`ja_dict_core.json: ${payload.entry_count} keys`);

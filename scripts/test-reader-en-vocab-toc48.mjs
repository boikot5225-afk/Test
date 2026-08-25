import fs from 'node:fs';
import assert from 'node:assert/strict';

const freq = fs.readFileSync('data/en_vocab_frequency.tsv','utf8').trimEnd().split(/\r?\n/).map(x=>x.split('\t'));
const lemma = new Map(fs.readFileSync('data/en_vocab_lemma.tsv','utf8').trimEnd().split(/\r?\n/).map(x=>{const i=x.indexOf('\t');return [x.slice(0,i),x.slice(i+1)];}));
assert.equal(freq.length,36566);
assert.equal(new Set(freq.map(x=>x[0])).size,36566);
for (const [i,w] of [[0,'I'],[1,'be'],[17,'go'],[999,'complete'],[4999,'microwave'],[36565,'unbend']]) assert.equal(freq[i][0],w);
for (const [s,t] of Object.entries({went:'go',gone:'go',going:'go',goes:'go',am:'be',is:'be',was:'be',were:'be',aimed:'aim',better:'good',best:'good'})) assert.equal(lemma.get(s),t);

const enVocab=fs.readFileSync('js/reader/en-vocab-estimate.js','utf8');
assert.match(enVocab,/STEP1_COUNT = 42/);
assert.match(enVocab,/STEP2_COUNT = 42/);
assert.match(enVocab,/WORDS_PER_PAGE = 14/);
assert.match(enVocab,/center\s*\*\s*\.35/);
assert.match(enVocab,/value\s*\*\s*0\.6/);
assert.match(enVocab,/manualKnowledge/);
assert.match(enVocab,/went:'go'/);

const gloss=fs.readFileSync('js/reader/en-unknown-gloss.js','utf8');
assert.match(gloss,/PREFETCH_PAGE_COUNT = 2/);
assert.match(gloss,/MAX_CONCURRENT = 4/);
assert.match(gloss,/readerPrepareEnStableSlots/);
assert.match(gloss,/rw-migaku-unknown/);
assert.ok(!gloss.includes("content:'…'"));

const runtime=fs.readFileSync('js/reader/interactions-runtime.js','utf8');
assert.match(runtime,/en-vocab-estimate\.js\?v=1/);
assert.match(runtime,/en-unknown-gloss\.js\?v=1/);
const pages=fs.readFileSync('js/reader/pages-mode.js','utf8');
assert.match(pages,/readerPrepareEnStableSlots/);
const zh=fs.readFileSync('js/reader/vocab-estimate.js','utf8');
assert.match(zh,/function decorateWordPanel\(\) \{\n  if \(currentLang\(\) !== 'zh'\) return;/);
console.log('English vocabulary toc48 regression checks passed');

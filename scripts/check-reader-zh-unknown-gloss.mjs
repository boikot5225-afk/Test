import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const glossPath = 'js/reader/zh-unknown-gloss-v4.js';
const layoutPath = 'js/reader/zh-readable-inline.js';
const spacingPath = 'js/reader/zh-unknown-gloss-spacing.js';
const runtimePath = 'js/reader/interactions-runtime.js';

const gloss = fs.readFileSync(glossPath, 'utf8');
const layout = fs.readFileSync(layoutPath, 'utf8');
const spacing = fs.readFileSync(spacingPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

assert.match(runtime, /import '\.\/zh-unknown-gloss-v4\.js\?v=\d+';/, 'Chinese data module is not loaded');
assert.match(runtime, /import '\.\/zh-readable-inline\.js\?v=\d+';/, 'Chinese readable layout is not loaded');
assert.match(gloss, /localStorage\.getItem\(MODE_KEY\) === 'unknown' \? 'unknown' : 'off'/, 'feature must default to off');
assert.match(gloss, /classList\.contains\('rw-migaku-known'\)/, 'known-word guard must use Migaku status');
assert.doesNotMatch(gloss, /const gloss = ru \|\| en/, 'English must never become a visible Chinese gloss');
assert.doesNotMatch(layout, /readerAI|task:\s*['"]reader_word/, 'reading must not automatically call Instant/AI');
assert.match(layout, /ReaderOfflineTranslate/, 'missing Russian hints must use the bundled offline EN→RU bridge');
assert.match(spacing, /customOn \? 'unknown' : 'off'/, 'custom mode must enable native pinyin for every Unknown word');

// Phone layout contract: all Chinese words share the same two-row inline grid,
// while the Russian width contribution remains small and bounded.
assert.match(layout, /\.rw-zh-gloss-wrap \{[\s\S]*display: inline-grid !important;/, 'all Chinese tokens must use the same inline grid');
assert.match(layout, /grid-template-rows: auto \.52em !important;/, 'all Hanzi must reserve one equal Russian row');
assert.match(layout, /vertical-align: baseline !important;/, 'Hanzi must share the normal text baseline');
assert.match(layout, /grid-row: 2 !important;/, 'Russian gloss must occupy the row below Hanzi');
assert.match(layout, /font-size: \.34em !important;/, 'Russian hint must remain legible without controlling text size');
assert.doesNotMatch(layout, /46vw|white-space:\s*normal|text-overflow:\s*ellipsis/, 'wide, vertical or clipped gloss columns must not return');
assert.doesNotMatch(layout, /position:\s*absolute\s*!important/, 'glosses must not float over neighbouring text');
assert.doesNotMatch(gloss + layout, /currentChapter\s*=|currentParagraph\s*=/, 'optional aid must not mutate navigation');

const dataModule = await import(pathToFileURL(glossPath).href + '?ci=' + Date.now());
assert.equal(dataModule.mode(), 'off');

const presentation = await import(pathToFileURL(layoutPath).href + '?ci=' + Date.now());
assert.equal(presentation.compactRussian('куча; груда; складывать'), 'куча');
assert.equal(presentation.compactRussian('Металл красноватого цвета, химический элемент (Cu).'), '');
assert.equal(presentation.compactRussian('подбирать'), 'подбирать');
assert.equal(presentation.compactRussian('[[вбива́ть]] [[сва́и]]'), 'вбивать сваи');
assert.equal(presentation.compactRussian('про́волока | кабель'), 'проволока');
assert.equal(presentation.compactRussian('a copper metal'), '', 'English must never pass the Russian formatter');
assert.equal(presentation.compactEnglish('to peel; to skin; to shell'), 'peel');
assert.deepEqual(presentation.englishCandidates('to seek proof'), ['seek proof', 'seek']);
assert.equal(presentation.glossWidth('подбирать'), '1.71em');
assert.equal(presentation.glossWidth('оченьдлинныйперевод'), '2.65em');

console.log('reader Chinese unknown-word gloss regression: PASS');

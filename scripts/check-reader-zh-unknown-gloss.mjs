import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const glossPath = 'js/reader/zh-unknown-gloss-v4.js';
const readablePath = 'js/reader/zh-readable-inline.js';
const runtimePath = 'js/reader/interactions-runtime.js';
const glossSource = fs.readFileSync(glossPath, 'utf8');
const readableSource = fs.readFileSync(readablePath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

assert.match(runtime, /import '\.\/zh-unknown-gloss-v4\.js\?v=\d+';/, 'Chinese Unknown data layer is not loaded');
assert.match(runtime, /import '\.\/zh-readable-inline\.js\?v=2';/, 'toc90 readable Chinese presentation is not loaded');
assert.doesNotMatch(runtime, /import '\.\/zh-unknown-interlinear\.js/, 'retired interlinear presentation must not be loaded');

assert.match(glossSource, /localStorage\.getItem\(MODE_KEY\) === 'unknown' \? 'unknown' : 'off'/, 'feature must default to off');
assert.match(glossSource, /classList\.contains\('rw-migaku-known'\)/, 'known-word guard must use Migaku status');
assert.match(glossSource, /reader-instant-word-translation/, 'manual Instant results must update Chinese Unknown glosses');
assert.doesNotMatch(glossSource, /currentChapter\s*=/, 'optional gloss module must not mutate chapter navigation');
assert.doesNotMatch(glossSource, /currentParagraph\s*=/, 'optional gloss module must not mutate paragraph navigation');

// toc90: one native pinyin only, one compact Russian meaning below it.
assert.match(readableSource, /native ruby\/pinyin renderer/, 'toc90 must explicitly reuse Reader native pinyin');
assert.match(readableSource, /task: 'reader_word'/, 'visible Unknown words must receive contextual word translation');
assert.match(readableSource, /context: clean\(context\)/, 'context must be sent to reader_word');
assert.match(readableSource, /display: inline-flex !important/, 'Unknown word + Russian gloss must be one vertical inline unit');
assert.match(readableSource, /position: static !important/, 'Russian gloss must participate in vertical layout instead of painting over text');
assert.match(readableSource, /ruby-position: over !important/, 'native ruby must stay above the Hanzi');
assert.match(readableSource, /word-break: keep-all !important/, 'Chinese token/pinyin must not split');
assert.doesNotMatch(readableSource, /className = 'rw-zh-readable-pinyin'/, 'a second pinyin DOM lane must never be created');
assert.doesNotMatch(readableSource, /> \.reader-word rt \{\s*display: none/s, 'native pinyin must not be hidden');
assert.doesNotMatch(readableSource, /text-overflow:\s*ellipsis/, 'annotations must not be ellipsized');

const gloss = await import(pathToFileURL(glossPath).href + '?ci=' + Date.now());
assert.equal(gloss.mode(), 'off', 'without explicit opt-in mode must be off');

const readable = await import(pathToFileURL(readablePath).href + '?ci=' + Date.now());
assert.equal(readable.compactRussian('куча, груда · складывать, накапливать'), 'куча');
assert.equal(readable.compactRussian('чистить (кожуру, скорлупу); снимать (шкуру)'), 'чистить');
assert.equal(readable.compactRussian('чистить (кожуру'), 'чистить');
assert.equal(readable.compactRussian('Металл красноватого цвета, химический элемент (Cu).'), 'Металл');
assert.notEqual(readable.contextKey('破烂', '我找到了一堆破烂'), readable.contextKey('破烂', '他穿得很破烂'), 'same word in different contexts must not share contextual gloss');

console.log('reader Chinese unknown-word gloss regression: PASS');

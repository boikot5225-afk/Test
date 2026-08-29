// toc91 regression: native pinyin + zero-geometry contextual Russian gloss.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const glossPath = 'js/reader/zh-unknown-gloss-v4.js';
const readablePath = 'js/reader/zh-readable-inline.js';
const spacingPath = 'js/reader/zh-unknown-gloss-spacing.js';
const runtimePath = 'js/reader/interactions-runtime.js';
const glossSource = fs.readFileSync(glossPath, 'utf8');
const readableSource = fs.readFileSync(readablePath, 'utf8');
const spacingSource = fs.readFileSync(spacingPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

assert.match(runtime, /import '\.\/zh-unknown-gloss-v4\.js\?v=\d+';/, 'Chinese Unknown data layer is not loaded');
assert.match(runtime, /import '\.\/zh-unknown-gloss-spacing\.js\?v=3';/, 'toc91 pinyin mode bridge is not loaded');
assert.match(runtime, /import '\.\/zh-readable-inline\.js\?v=3';/, 'toc91 readable Chinese presentation is not loaded');
assert.doesNotMatch(runtime, /import '\.\/zh-unknown-interlinear\.js/, 'retired interlinear presentation must not be loaded');

assert.match(glossSource, /localStorage\.getItem\(MODE_KEY\) === 'unknown' \? 'unknown' : 'off'/, 'feature must default to off');
assert.match(glossSource, /classList\.contains\('rw-migaku-known'\)/, 'known-word guard must use Migaku status');
assert.match(glossSource, /reader-instant-word-translation/, 'manual Instant results must update Chinese Unknown glosses');
assert.doesNotMatch(glossSource, /currentChapter\s*=/, 'optional gloss module must not mutate chapter navigation');
assert.doesNotMatch(glossSource, /currentParagraph\s*=/, 'optional gloss module must not mutate paragraph navigation');

// The old spacing module is now bridge-only. It must never inject line-height or
// pseudo annotation CSS again.
assert.doesNotMatch(spacingSource, /line-height:\s*2\./, 'legacy spacing module must not alter Chinese line height');
assert.doesNotMatch(spacingSource, /::before|::after/, 'legacy spacing module must not draw annotation pseudo-elements');
assert.match(spacingSource, /RETIRED_STYLE_ID/, 'bridge must actively remove the retired spacing style');

// toc91 core contract: text geometry is native Reader geometry.
assert.match(readableSource, /Reader already owns Hanzi \+ ruby\/pinyin/, 'toc91 must explicitly reuse native Hanzi/pinyin');
assert.match(readableSource, /task: 'reader_word'/, 'visible Unknown words must receive contextual word translation');
assert.match(readableSource, /targetLang: 'ru'/, 'context translation must explicitly target Russian');
assert.match(readableSource, /Prefer exactly ONE Russian word/, 'context prompt must demand one compact Russian meaning');
assert.match(readableSource, /display: contents !important/, 'data wrapper must disappear from layout');
assert.match(readableSource, /position: absolute !important/, 'Russian gloss must be out of normal flow');
assert.match(readableSource, /top: 1\.16em !important/, 'Russian gloss must stay inside the existing CJK word line box');
assert.match(readableSource, /word\.appendChild\(lane\)/, 'Russian gloss must anchor inside the native word, not widen the wrapper');
assert.doesNotMatch(readableSource, /display:\s*inline-flex\s*!important/, 'Unknown words must never become flex items');
assert.doesNotMatch(readableSource, /display:\s*inline-grid\s*!important/, 'Unknown words must never become grid items');
assert.doesNotMatch(readableSource, /grid-template|flex-direction/, 'presentation must not rebuild token geometry');
assert.doesNotMatch(readableSource, /reader-paragraph-text\s*\{[^}]*line-height/s, 'gloss layer must not change paragraph text line-height');
assert.doesNotMatch(readableSource, /rt\.textContent\s*=/, 'context layer must never rewrite native pinyin');
assert.doesNotMatch(readableSource, /className = 'rw-zh-readable-pinyin'/, 'a second pinyin DOM lane must never be created');
assert.doesNotMatch(readableSource, /text-overflow:\s*ellipsis/, 'annotations must not be ellipsized');

const gloss = await import(pathToFileURL(glossPath).href + '?ci=' + Date.now());
assert.equal(gloss.mode(), 'off', 'without explicit opt-in mode must be off');

const readable = await import(pathToFileURL(readablePath).href + '?ci=' + Date.now());
assert.equal(readable.compactRussian('куча, груда · складывать, накапливать'), 'куча');
assert.equal(readable.compactRussian('чистить (кожуру, скорлупу); снимать (шкуру)'), 'чистить');
assert.equal(readable.compactRussian('чистить (кожуру'), 'чистить');
assert.equal(readable.safeDictionaryRussian('Металл красноватого цвета, химический элемент (Cu).'), '', 'encyclopedic copper prose must never show as Металл');
assert.equal(readable.safeDictionaryRussian('медь'), 'медь');
assert.equal(readable.contextualRussian('бродяга'), 'бродяга');
assert.equal(readable.contextualRussian('искать доказательства'), 'искать доказательства');
assert.equal(readable.contextualRussian('это длинное объяснение значения слова'), '', 'verbose AI output must stay invisible');
assert.notEqual(readable.contextKey('破烂', '我找到了一堆破烂'), readable.contextKey('破烂', '他穿得很破烂'), 'same word in different contexts must not share contextual gloss');

console.log('reader Chinese unknown-word gloss regression: PASS');

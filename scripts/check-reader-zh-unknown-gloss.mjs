import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const modulePath = 'js/reader/zh-unknown-gloss-v4.js';
const interlinearPath = 'js/reader/zh-unknown-interlinear.js';
const runtimePath = 'js/reader/interactions-runtime.js';
const source = fs.readFileSync(modulePath, 'utf8');
const interlinear = fs.readFileSync(interlinearPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

// Cache-busting query versions are implementation details; require the module,
// not the historical literal.
assert.match(runtime, /import '\.\/zh-unknown-gloss-v4\.js\?v=\d+';/, 'active Chinese gloss module is not loaded by reader runtime');
assert.match(runtime, /import '\.\/zh-unknown-interlinear\.js\?v=\d+';/, 'Chinese interlinear layout is not loaded by reader runtime');
assert.match(source, /localStorage\.getItem\(MODE_KEY\) === 'unknown' \? 'unknown' : 'off'/, 'feature must default to off');
assert.match(source, /if \(!enabled\(\) \|\| currentLang\(\) !== 'zh'\) return;/, 'disabled mode must bail before scanning reader DOM');
assert.match(source, /classList\.contains\('rw-migaku-known'\)/, 'known-word guard must use Migaku status');
assert.doesNotMatch(source, /task: 'reader_word'/, 'automatic Chinese annotations must stay offline-only');
assert.match(source, /reader-instant-word-translation/, 'manual Instant results must update Chinese Unknown glosses');
assert.match(source, /INSTANT_WORD_CACHE_KEY/, 'manual Instant results must survive chapter and book reloads');

// toc87 presentation contract: Russian is one compact display sense and must
// not control intrinsic token width. Hanzi and pinyin, however, must stay whole.
assert.match(interlinear, /content:attr\(data-zh-gloss-display-ru\)/, 'visible Russian gloss must use the compact display field');
assert.match(interlinear, /position:absolute\s*!important/, 'Russian gloss must be painted out of intrinsic token sizing');
assert.match(interlinear, /grid-template-columns:max-content\s*!important/, 'Hanzi/pinyin must own the intrinsic column width');
assert.match(interlinear, /word-break:keep-all\s*!important/, 'Chinese lexical units must never split vertically');
assert.match(interlinear, /white-space:nowrap\s*!important/, 'pinyin and compact gloss must remain on one readable line');
assert.match(interlinear, /max-width:none\s*!important/, 'pinyin must not be clipped to an arbitrary phone-width cap');
assert.doesNotMatch(interlinear, /46vw/, 'toc86 wide Russian columns must not return');
assert.doesNotMatch(interlinear, /text-overflow:\s*ellipsis/, 'no visible Chinese annotation may be ellipsized');
assert.doesNotMatch(source, /currentChapter\s*=/, 'optional gloss module must not mutate chapter navigation');
assert.doesNotMatch(source, /currentParagraph\s*=/, 'optional gloss module must not mutate paragraph navigation');

const mod = await import(pathToFileURL(modulePath).href + '?ci=' + Date.now());
assert.equal(mod.mode(), 'off', 'without an explicit user opt-in the mode must be off');
assert.equal(mod.compactGloss('смотреть; глядеть; наблюдать'), 'смотреть · глядеть');
assert.equal(mod.compactGloss('свидетельствовать о происходящем'), 'свидетельствовать о происходящем', 'source cache keeps its full sense; display compaction happens later');
assert.notEqual(mod.cacheKey('目光', '他的目光很冷'), mod.cacheKey('目光', '目光落在门口'), 'same word in different contexts must not share a contextual gloss');

const layout = await import(pathToFileURL(interlinearPath).href + '?ci=' + Date.now());
assert.equal(layout.compactDisplayGloss('куча, груда · складывать, накапливать'), 'куча');
assert.equal(layout.compactDisplayGloss('чистить (кожуру, скорлупу); снимать (шкуру)'), 'чистить');
assert.equal(layout.compactDisplayGloss('wire · power cord'), 'wire');
const copper = layout.compactRussianDisplay('Металл красноватого цвета, химический элемент (Cu). Также используется для обозначения сплавов меди.');
assert.ok(copper.length <= 38 && !/Также|используется/.test(copper), 'encyclopedic Russian prose must collapse to one short display phrase');

const fakeKnown = { classList: { contains: (name) => name === 'rw-migaku-known' } };
const fakeUnknown = { classList: { contains: (name) => name === 'rw-migaku-unknown' } };
assert.equal(mod.knowledgeState(fakeKnown), 'known');
assert.equal(mod.knowledgeState(fakeUnknown), 'unknown');

console.log('reader Chinese unknown-word gloss regression: PASS');

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const modulePath = 'js/reader/zh-unknown-gloss.js';
const runtimePath = 'js/reader/interactions-runtime.js';
const source = fs.readFileSync(modulePath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

// Cache-busting query versions are implementation details; require the module,
// not the historical ?v=1 literal.
assert.match(runtime, /import '\.\/zh-unknown-gloss\.js\?v=\d+';/, 'Chinese gloss module is not loaded by reader runtime');
assert.match(source, /localStorage\.getItem\(MODE_KEY\) === 'unknown' \? 'unknown' : 'off'/, 'feature must default to off');
assert.match(source, /if \(!enabled\(\)\) return;/, 'disabled mode must bail before touching reader DOM');
assert.match(source, /classList\?\.contains\('rw-known'\)/, 'known-word guard must use the reader core status');
assert.match(source, /task: 'reader_word'/, 'missing contextual Chinese word lookup');
assert.doesNotMatch(source, /currentChapter\s*=/, 'optional gloss module must not mutate chapter navigation');
assert.doesNotMatch(source, /currentParagraph\s*=/, 'optional gloss module must not mutate paragraph navigation');

const mod = await import(pathToFileURL(modulePath).href + '?ci=' + Date.now());
assert.equal(mod.mode(), 'off', 'without an explicit user opt-in the mode must be off');
assert.equal(mod.compactRussian('смотреть; глядеть; наблюдать'), 'смотреть · глядеть');
assert.notEqual(mod.cacheKey('目光', '他的目光很冷'), mod.cacheKey('目光', '目光落在门口'), 'same word in different contexts must not share a contextual gloss');

const fakeKnown = { classList: { contains: (name) => name === 'rw-known' } };
const fakeUnknown = { classList: { contains: () => false } };
assert.equal(mod.isKnownElement(fakeKnown), true);
assert.equal(mod.isKnownElement(fakeUnknown), false);

console.log('reader Chinese unknown-word gloss regression: PASS');

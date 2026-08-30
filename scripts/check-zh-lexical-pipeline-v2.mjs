#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { ranksFromText, segmentChineseWeighted, scoreChineseSegmentation } from '../js/reader/zh-segment-v2.js';
import { classifyChineseGloss, chinesePinyinNeedsContext } from '../js/reader/zh-lexical-trust.js';

const rankPath = process.argv[2] || 'android/app/src/main/assets/data/zh_jieba_top100k.txt';
const corePath = process.argv[3] || 'data/zh_dict_core.json';
const corpusPath = process.argv[4] || 'data/zh_lexical_regressions.json';

const ranks = ranksFromText(fs.readFileSync(rankPath, 'utf8'));
assert.ok(ranks.size >= 99_000, `rank asset too small: ${ranks.size}`);
const corePayload = JSON.parse(fs.readFileSync(corePath, 'utf8'));
const core = corePayload.map || {};
const hasWord = word => Object.prototype.hasOwnProperty.call(core, word);
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

const isHan = token => /^[\u3400-\u9fff]+$/.test(token);
const failures = [];
for (const test of corpus) {
  const tokens = segmentChineseWeighted(test.text, { ranks, hasWord });
  const han = tokens.filter(isHan);
  let ok = true;
  if (Array.isArray(test.must)) ok &&= JSON.stringify(han) === JSON.stringify(test.must);
  if (Array.isArray(test.mustContain)) ok &&= test.mustContain.every(item => han.includes(item));
  if (Array.isArray(test.forbid)) ok &&= test.forbid.every(item => !han.includes(item));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${test.id}: ${tokens.join(' | ')}`);
  if (!ok) failures.push({ id: test.id, expected: test, actual: han });
}

// The scorer must prefer the known good path on our two original catastrophic
// examples. This protects readerChooseBestChineseSegmentation from later
// reintroducing greedy/remote garbage.
for (const [text, good, bad] of [
  ['代以太平军或相应之名称', ['代','以','太平军','或','相应','之','名称'], ['代','以太','平','军','或','相应','之','名称']],
  ['凡有违反本法', ['凡','有','违反','本法'], ['凡','有违','反','本法']],
]) {
  const goodCost = scoreChineseSegmentation(good, { ranks, hasWord });
  const badCost = scoreChineseSegmentation(bad, { ranks, hasWord });
  assert.ok(goodCost < badCost, `${text}: good path ${goodCost} must beat bad ${badCost}`);
}

// Translation provenance gate. DOM is represented by the tiny surface the
// trust module actually reads; no browser is needed for this policy test.
function fakeWrap({ displayed = '', source = '' } = {}) {
  return {
    dataset: { zhGlossSource: source },
    querySelector() { return displayed ? { textContent: displayed } : null; },
  };
}

assert.equal(classifyChineseGloss({ wrap: fakeWrap(), entry: null }).needsContext, true);
assert.equal(classifyChineseGloss({ wrap: fakeWrap({ displayed: 'Национальный номер', source: 'mlkit-zh-ru' }) }).needsContext, true);
assert.equal(classifyChineseGloss({ wrap: fakeWrap({ displayed: 'Заглавие', source: 'wikdict-en-ru' }) }).needsContext, true);
assert.equal(classifyChineseGloss({ wrap: fakeWrap({ displayed: 'название государства', source: 'context-ai' }) }).needsContext, false);
assert.equal(classifyChineseGloss({ wrap: fakeWrap({ displayed: 'смерть' }), entry: { ru: 'смерть', _source: 'zh_reading' } }).needsContext, false);

// Pronunciation confidence is independent from translation confidence.
// A trusted RU gloss for 行 must not suppress the contextual háng/xí choice.
assert.equal(chinesePinyinNeedsContext('行'), true);
assert.equal(chinesePinyinNeedsContext('还'), true);
assert.equal(chinesePinyinNeedsContext('国号'), false);
assert.equal(chinesePinyinNeedsContext('供应链'), false);

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log(`Chinese lexical pipeline v2 gate: ${corpus.length}/${corpus.length} segmentation cases + RU/pinyin trust policy PASS`);

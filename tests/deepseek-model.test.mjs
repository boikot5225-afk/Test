import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DEFAULT_DEEPSEEK_MODEL,
  resolveDeepSeekModel,
} = require('../functions/deepseek-model.js');

test('uses the current flash model by default', () => {
  assert.equal(DEFAULT_DEEPSEEK_MODEL, 'deepseek-v4-flash');
  assert.equal(resolveDeepSeekModel(), 'deepseek-v4-flash');
  assert.equal(resolveDeepSeekModel(''), 'deepseek-v4-flash');
});

test('maps retired DeepSeek aliases to v4 flash', () => {
  assert.equal(resolveDeepSeekModel('deepseek-chat'), 'deepseek-v4-flash');
  assert.equal(resolveDeepSeekModel('deepseek-reasoner'), 'deepseek-v4-flash');
  assert.equal(resolveDeepSeekModel(' DEEPSEEK-CHAT '), 'deepseek-v4-flash');
});

test('keeps supported v4 models', () => {
  assert.equal(resolveDeepSeekModel('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});

test('does not send an unsupported environment value to the API', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(resolveDeepSeekModel('some-old-model'), 'deepseek-v4-flash');
  } finally {
    console.warn = originalWarn;
  }
});

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  buildDeepSeekJsonRequest,
  deepSeekMessageContent,
  deepSeekFinishReason,
} = require('../functions/deepseek-json.js');

const body = buildDeepSeekJsonRequest({
  model: 'deepseek-v4-flash',
  maxTokens: 450,
  userPrompt: 'Return JSON: {"ru":"..."}',
});

assert.deepEqual(body.thinking, { type: 'disabled' });
assert.deepEqual(body.response_format, { type: 'json_object' });
assert.equal(body.model, 'deepseek-v4-flash');
assert.equal(body.max_tokens, 450);
assert.match(body.messages[0].content, /JSON/i);
assert.equal(
  deepSeekMessageContent({ choices: [{ message: { content: '  {"ru":"Да"}  ' } }] }),
  '{"ru":"Да"}',
);
assert.equal(deepSeekFinishReason({ choices: [{ finish_reason: 'stop' }] }), 'stop');
assert.equal(deepSeekMessageContent({}), '');

console.log('deepseek JSON request: OK');

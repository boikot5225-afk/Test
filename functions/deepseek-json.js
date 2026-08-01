'use strict';

function buildDeepSeekJsonRequest({ model, maxTokens, userPrompt }) {
  return {
    model,
    // DeepSeek V4 enables thinking by default. These reader tasks are small
    // structured-output requests; disabling thinking prevents the reasoning
    // budget from consuming the short output allowance before JSON is emitted.
    thinking: { type: 'disabled' },
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Return only valid JSON. No markdown. No extra text.' },
      { role: 'user', content: userPrompt },
    ],
  };
}

function deepSeekMessageContent(data) {
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

function deepSeekFinishReason(data) {
  return String(data?.choices?.[0]?.finish_reason || '').trim();
}

module.exports = {
  buildDeepSeekJsonRequest,
  deepSeekMessageContent,
  deepSeekFinishReason,
};

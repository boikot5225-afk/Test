'use strict';

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
const SUPPORTED_DEEPSEEK_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]);
const RETIRED_DEEPSEEK_MODELS = new Set([
  'deepseek-chat',
  'deepseek-reasoner',
]);

function resolveDeepSeekModel(value = process.env.DEEPSEEK_MODEL) {
  const configured = String(value || '').trim().toLowerCase();

  if (!configured || RETIRED_DEEPSEEK_MODELS.has(configured)) {
    return DEFAULT_DEEPSEEK_MODEL;
  }

  if (SUPPORTED_DEEPSEEK_MODELS.has(configured)) {
    return configured;
  }

  console.warn(
    `[readerAI] Unsupported DEEPSEEK_MODEL "${configured}", using ${DEFAULT_DEEPSEEK_MODEL}.`
  );
  return DEFAULT_DEEPSEEK_MODEL;
}

module.exports = {
  DEFAULT_DEEPSEEK_MODEL,
  resolveDeepSeekModel,
};

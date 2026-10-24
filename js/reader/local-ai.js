// Experimental local AI adapter for Reader AI.
// Talks to the native ReaderLocalAI bridge, which forwards requests to
// http://127.0.0.1:8080/v1/chat/completions without WebView CORS.

const SUPPORTED_TASKS = new Set(['reader_word', 'translate_paragraph']);
const TIMEOUT_MS = 125000;
let seq = 0;
const pending = new Map();

function langName(lang) {
  const key = String(lang || '').toLowerCase().split('-')[0];
  return ({
    zh: 'Chinese',
    ja: 'Japanese',
    en: 'English',
    fr: 'French',
    es: 'Spanish',
    de: 'German',
  })[key] || key || 'source-language';
}

function parseJsonObject(text) {
  let raw = String(text || '').trim();
  if (!raw) throw new Error('Локальная модель вернула пустой ответ.');
  raw = raw
    .replace(/^\`\`\`(?:json)?\\s*/i, '')
    .replace(/\\s*\`\`\`$/i, '')
    .trim();
  try { return JSON.parse(raw); } catch (_) {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  throw new Error('Локальная модель вернула не JSON: ' + raw.slice(0, 220));
}

function promptFor(payload) {
  const task = String((payload && payload.task) || '').trim();
  const sourceLang = String((payload && payload.sourceLang) || '');
  if (task === 'reader_word') {
    const token = String((payload && (payload.word || payload.surface)) || '').trim();
    const context = String((payload && payload.context) || '').trim();
    const instruction = String((payload && payload.instruction) || '').trim();
    const hint = payload && payload.hint && typeof payload.hint === 'object'
      ? '\nLOCAL DICTIONARY HINT: ' + JSON.stringify(payload.hint)
      : '';
    return [
      'You are the lexical assistant inside a language-reading app.',
      'Analyze the selected token IN ITS EXACT CONTEXT for a Russian-speaking learner.',
      'The Russian meaning must be short, natural and contextual, not a blind dictionary gloss.',
      instruction || 'Return ONLY valid JSON with the requested lexical fields and a short Russian meaning.',
      'Do not wrap JSON in markdown. Do not add prose before or after JSON.',
      hint,
      'LANGUAGE: ' + langName(sourceLang),
      'TOKEN: ' + token,
      'CONTEXT: ' + context,
    ].filter(Boolean).join('\n');
  }
  if (task === 'translate_paragraph') {
    const text = String((payload && payload.text) || '').trim();
    return [
      'Translate the following ' + langName(sourceLang) + ' paragraph into natural Russian for comprehension.',
      'Preserve names, tone, slang, idioms and the actual contextual meaning. Do not explain grammar.',
      'Return ONLY valid JSON exactly in this shape: {"ru":"..."}',
      'Do not wrap JSON in markdown. Do not add any text outside JSON.',
      'TEXT:',
      text,
    ].join('\n');
  }
  throw new Error('Local AI does not support task: ' + task);
}

function bridgeReady() {
  return !!(globalThis.ReaderLocalAI && typeof globalThis.ReaderLocalAI.chat === 'function');
}

globalThis.__readerLocalAiResolve = function(requestId, responseText, errorText) {
  const id = String(requestId || '');
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id);
  clearTimeout(item.timer);
  if (errorText) {
    item.reject(new Error(String(errorText)));
    return;
  }
  try {
    const wire = JSON.parse(String(responseText || '{}'));
    const choices = Array.isArray(wire.choices) ? wire.choices : [];
    const first = choices[0] || {};
    const content = (first.message && first.message.content) || first.text || '';
    item.resolve(parseJsonObject(content));
  } catch (e) {
    item.reject(e);
  }
};

export function readerLocalAiSupported(payload) {
  return SUPPORTED_TASKS.has(String((payload && payload.task) || '').trim());
}

export function readerLocalAiBridgeReady() {
  return bridgeReady();
}

export function readerLocalAi(payload) {
  if (!bridgeReady()) {
    return Promise.reject(new Error('Локальный AI-мост недоступен в этой сборке.'));
  }
  const task = String((payload && payload.task) || '').trim();
  if (!SUPPORTED_TASKS.has(task)) {
    return Promise.reject(new Error('Локальный AI пока не поддерживает task: ' + task));
  }

  const requestId = 'reader_local_' + Date.now() + '_' + (++seq);
  const body = {
    model: 'local',
    stream: false,
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: task === 'reader_word' ? 650 : 1200,
    messages: [
      {
        role: 'system',
        content: 'Follow the user instruction exactly. For this request, output only strict JSON and no markdown.',
      },
      {
        role: 'user',
        content: promptFor(payload),
      },
    ],
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Локальная модель не ответила за 125 секунд.'));
    }, TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    try {
      globalThis.ReaderLocalAI.chat(requestId, JSON.stringify(body));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(e);
    }
  });
}

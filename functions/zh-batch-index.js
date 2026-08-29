const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { resolveDeepSeekModel } = require('./deepseek-model');

const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
const MAX_CONTEXT_CHARS = 1200;
const MAX_TARGETS = 24;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('Model returned non-JSON text');
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeRu(value) {
  const text = clean(value, 36)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?。！？]+$/g, '')
    .trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2) return '';
  return text;
}

function normalizePinyin(value) {
  const text = clean(value, 72)
    .replace(/[，。！？；：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /[\u0400-\u052f\u4e00-\u9fff]/.test(text)) return '';
  return text;
}

function safeTarget(raw, index) {
  const surface = clean(raw?.surface || raw?.word, 32);
  if (!surface || !/[\u3400-\u9fff]/.test(surface)) return null;
  return {
    id: clean(raw?.id || `t${index}`, 40) || `t${index}`,
    surface,
    pinyin: clean(raw?.pinyin, 72),
    en: clean(raw?.en || raw?.english, 220),
    alt: clean(raw?.alt, 80),
    hsk: clean(raw?.hsk, 24),
    newHsk: clean(raw?.newHsk, 24),
    blcuRank: Number.isFinite(Number(raw?.blcuRank)) ? Number(raw.blcuRank) : null,
    subtlexRank: Number.isFinite(Number(raw?.subtlexRank)) ? Number(raw.subtlexRank) : null,
    jiebaRank: Number.isFinite(Number(raw?.jiebaRank)) ? Number(raw.jiebaRank) : null,
  };
}

function buildPrompt(context, targets) {
  return `You are the contextual Chinese reading-gloss engine for a Russian-speaking learner.

You receive ONE exact Chinese paragraph and a list of token OCCURRENCES that Reader currently marks Unknown. The tokenization may occasionally be wrong, so do not blindly trust a dictionary sense that conflicts with the sentence.

For every target return:
- id: copy exactly;
- ru: the meaning AS USED HERE, in natural Russian, strictly 1-2 words, never an English gloss and never an explanation;
- pinyin: the pronunciation of THIS SURFACE IN THIS CONTEXT, with tone marks. Resolve polyphonic characters from context;
- confidence: number 0..1;
- boundary: "ok" if the supplied token is a sensible word boundary here, or "suspect" if it appears to cross/split a real word or name;
- suggestion: only when boundary="suspect", a very short better local segmentation, otherwise "".

Important examples of the required behaviour:
- 特警 in a police context -> ru "спецназ", not a literal translation of English "SWAT" such as a verb.
- 摇头 -> ru "качать головой" or "покачать головой" only if it fits the exact sentence.
- 还 must be hái or huán according to context, not whichever reading is first in a dictionary.
- In 眼神里带着几分嘲讽, a supplied token 里带 should be boundary="suspect" because the useful segmentation is 里 / 带着.
- Proper names may be boundary="suspect" when Reader split the name into ordinary dictionary words.

Dictionary hints are evidence only. They can be incomplete or misleading. The paragraph context wins.
Return ONLY JSON with this exact top-level shape:
{"items":[{"id":"t0","ru":"...","pinyin":"...","confidence":0.95,"boundary":"ok","suggestion":""}]}
Return one item for every supplied id and no extra ids.

CONTEXT:
${context}

TARGETS:
${JSON.stringify(targets)}`;
}

exports.readerZhBatch = onCall(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 75,
    memory: '256MiB',
    secrets: [DEEPSEEK_API_KEY],
    cors: true,
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Нужно войти в Firebase Auth.');
    }

    const body = request.data || {};
    const context = clean(body.context, MAX_CONTEXT_CHARS);
    if (!context || !/[\u3400-\u9fff]/.test(context)) {
      throw new HttpsError('invalid-argument', 'Нужен китайский context.');
    }

    const rawTargets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS) : [];
    const targets = rawTargets.map(safeTarget).filter(Boolean);
    if (!targets.length) throw new HttpsError('invalid-argument', 'Нет Unknown targets.');

    const ids = new Set();
    for (const target of targets) {
      if (ids.has(target.id)) throw new HttpsError('invalid-argument', 'Повторяющийся target id.');
      ids.add(target.id);
    }

    const key = DEEPSEEK_API_KEY.value();
    if (!key) throw new HttpsError('failed-precondition', 'Missing DEEPSEEK_API_KEY.');

    let response;
    try {
      response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: resolveDeepSeekModel(),
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
          temperature: 0.05,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: 'Return only valid JSON. No markdown. No extra text.' },
            { role: 'user', content: buildPrompt(context, targets) },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new HttpsError('unavailable', `DeepSeek network error: ${error?.message || String(error)}`);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.message || data?.error || `DeepSeek HTTP ${response.status}`;
      throw new HttpsError('internal', String(msg));
    }

    let parsed;
    try {
      parsed = extractJson(data?.choices?.[0]?.message?.content || '');
    } catch (error) {
      throw new HttpsError('internal', `DeepSeek вернул не JSON: ${error?.message || String(error)}`);
    }

    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const byId = new Map();
    for (const raw of rawItems) {
      const id = clean(raw?.id, 40);
      if (!ids.has(id) || byId.has(id)) continue;
      byId.set(id, {
        id,
        ru: normalizeRu(raw?.ru),
        pinyin: normalizePinyin(raw?.pinyin),
        confidence: clamp01(raw?.confidence),
        boundary: String(raw?.boundary || '').toLowerCase() === 'suspect' ? 'suspect' : 'ok',
        suggestion: clean(raw?.suggestion, 48),
      });
    }

    const items = targets.map((target) => byId.get(target.id) || {
      id: target.id,
      ru: '',
      pinyin: '',
      confidence: 0,
      boundary: 'ok',
      suggestion: '',
    });

    return { items };
  },
);

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
const MAX_CONTEXT_CHARS = 1800;
const MAX_TARGETS = 24;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeRu(value) {
  const text = clean(value, 48)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?…]+$/g, '')
    .trim();
  if (!/[\u0400-\u052f]/u.test(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return '';
  return text;
}

function safeTarget(raw, index) {
  const surface = clean(raw?.surface || raw?.word, 48);
  if (!surface || !/[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]/u.test(surface)) return null;
  const senses = Array.isArray(raw?.senses)
    ? raw.senses.map(v => safeRu(v)).filter(Boolean).slice(0, 8)
    : [];
  return {
    id: clean(raw?.id || `t${index}`, 40) || `t${index}`,
    surface,
    lemma: clean(raw?.lemma, 48),
    localRu: safeRu(raw?.localRu),
    senses,
  };
}

function buildPrompt(context, targets) {
  return `You are the contextual French->Russian inline-gloss engine for a book reader.

You receive ONE exact French paragraph and a list of token OCCURRENCES currently marked Unknown. Return the meaning of EACH OCCURRENCE AS USED IN THIS EXACT PARAGRAPH.

For every target return:
- id: copy exactly;
- ru: short natural Russian gloss for THIS occurrence, normally 1-4 words;
- lemma: French dictionary lemma/infinitive;
- pos: noun|verb|adjective|adverb|pronoun|preposition|conjunction|proper_noun|other;
- confidence: number 0..1;
- note: optional very short Russian phrase naming the fixed expression/collocation when it changes the sense, otherwise "".

STRICT RULES:
1. Context wins over the first dictionary sense and over localRu/senses hints.
2. Conjugated French verbs must be glossed in a natural Russian form that matches THIS sentence when useful, not automatically as an infinitive. Examples: "je précise" -> "уточняю"; "tu t'ennuieras" -> "тебе надоест"; "nous sommes contraints" -> "мы вынуждены" / "вынуждены".
3. Keep French clitics when Russian needs them: t'ennuie / t'ennuiera may need "тебя/тебе" in ru.
4. Fixed expressions/collocations must use their real meaning. "user la force" -> "применить (силу)", never "износить". "se hâter de" -> "спешить/спешу" according to the sentence. "avoir hâte de" -> "не терпится" when that is the actual construction.
5. Adjectives/participles should fit the local meaning and form: "ennuyée" may mean "огорчена/расстроена/скучающая" depending on the exact sentence; choose from context, do not blindly use "надоедать".
6. Adverbs and nouns get the short contextual lexical meaning: "personnellement" -> "лично"; "moindre" in "le moindre" -> "малейший".
7. If a target is a real proper name, set pos="proper_noun" and ru="". Do not invent translations for names.
8. localRu and senses are HINTS ONLY. They may be wrong. Never preserve a wrong hint just because it is present.
9. Return one item for EVERY supplied id, no missing ids and no extra ids.
10. Return ONLY JSON with this exact top-level shape:
{"items":[{"id":"t0","ru":"...","lemma":"...","pos":"verb","confidence":0.95,"note":""}]}

CONTEXT:
${context}

TARGETS:
${JSON.stringify(targets)}`;
}

function parseJson(text) {
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

exports.frContextBatch = onCall(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 90,
    memory: '256MiB',
    secrets: [DEEPSEEK_API_KEY],
    cors: true,
  },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Нужно войти в Firebase Auth.');

    const body = request.data || {};
    const context = clean(body.context, MAX_CONTEXT_CHARS);
    const targets = (Array.isArray(body.targets) ? body.targets : [])
      .slice(0, MAX_TARGETS)
      .map(safeTarget)
      .filter(Boolean);

    if (!context || !/[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]/u.test(context)) {
      throw new HttpsError('invalid-argument', 'Нужен французский context.');
    }
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
          model: 'deepseek-v4-flash',
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
          temperature: 0.05,
          max_tokens: 1500,
          messages: [
            { role: 'system', content: 'Return only valid JSON. No markdown. No extra text.' },
            { role: 'user', content: buildPrompt(context, targets) },
          ],
        }),
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
      parsed = parseJson(data?.choices?.[0]?.message?.content || '');
    } catch (error) {
      throw new HttpsError('internal', `DeepSeek вернул не JSON: ${error?.message || String(error)}`);
    }

    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const byId = new Map(rawItems.map(item => [clean(item?.id, 40), item]));
    const items = targets.map((target) => {
      const raw = byId.get(target.id) || {};
      const pos = clean(raw?.pos, 24).toLowerCase();
      const proper = pos === 'proper_noun';
      return {
        id: target.id,
        ru: proper ? '' : safeRu(raw?.ru),
        lemma: clean(raw?.lemma || target.lemma || target.surface, 48),
        pos: pos || 'other',
        confidence: Math.max(0, Math.min(1, Number(raw?.confidence || 0))),
        note: clean(raw?.note, 90),
      };
    });

    return { items };
  },
);

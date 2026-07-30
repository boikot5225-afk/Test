const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app';
if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: DATABASE_URL });
}

// v68.20: no hard daily AI limits.
// We only record usage counters in Realtime Database for visibility/debugging.
const DAILY_LIMITS = Object.freeze({});

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function safeTask(task) {
  return String(task || '').replace(/[^a-z0-9_:-]/gi, '_').slice(0, 60);
}

async function enforceDailyLimit(uid, task) {
  // No blocking limit anymore. Increment the usage counter and continue.
  // If DB write fails, do not block DeepSeek.
  const ref = admin.database().ref(`ai_usage/${uid}/${todayKey()}/${safeTask(task)}`);
  try {
    await ref.transaction((current) => Number(current || 0) + 1);
  } catch (_) {
    // Usage accounting is non-critical.
  }
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


// The reader sends every language it can import. Recognising only zh here used
// to route English and Spanish into the French prompts below.
function sourceLang(body) {
  const raw = String(body?.sourceLang || body?.lang || 'fr').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn' || raw === 'chinese') return 'zh';
  if (raw === 'ja' || raw.startsWith('ja-') || raw === 'jp' || raw === 'japanese') return 'ja';
  if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en';
  if (raw === 'es' || raw.startsWith('es-') || raw === 'spanish') return 'es';
  return 'fr';
}

function sourceLangName(code) {
  return { zh: 'Chinese', ja: 'Japanese', en: 'English', es: 'Spanish' }[code] || 'French';
}

function buildPrompt(task, body) {
  const lang = sourceLang(body);
  const langName = sourceLangName(lang);

  if (task === 'reader_word') {
    if (lang === 'zh') {
      return `You are a Chinese-Russian lexical assistant for a language reader. Analyze the selected Chinese token in context. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|particle|measure_word|proper_noun|other), lemma, surface, pinyin, ru, level (HSK1|HSK2|HSK3|HSK4|HSK5|HSK6|unknown), form_note, note. Rules: pinyin must use tone marks; ru must be short and natural Russian; if the token is a name or place, mark proper_noun; do not invent grammar essays.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
    }
    if (lang === 'ja') {
      // The app resolves the dictionary form and the reading locally against
      // JMdict before asking. Passing that through stops the model from
      // second-guessing settled facts and keeps the answer on the meaning.
      const hint = body.hint && body.hint.lemma
        ? `\nThe reader's local JMdict entry gives lemma "${body.hint.lemma}", reading "${body.hint.reading || ''}", English "${body.hint.en || ''}". Keep those unless the context clearly contradicts them, and spend the answer on a natural Russian meaning.`
        : '';
      return `You are a Japanese-Russian lexical assistant for a language reader. Analyze the selected Japanese token in context. Return ONLY valid JSON with keys: pos (noun|verb|i_adjective|na_adjective|adverb|particle|counter|proper_noun|other), lemma, surface, reading, ru, level (N5|N4|N3|N2|N1|unknown), form_note, note. Rules: lemma is the dictionary form (辞書形) written the way it appears in text — 読んだ → 読む, 高くて → 高い; reading is the WHOLE word in hiragana (a katakana word keeps katakana); form_note names the inflected surface form in Russian ("て-форма", "прошедшее", "отрицание", "вежливая форма", "потенциальная форма"); ru must be short and natural Russian; if the token is a name or place, mark proper_noun; do not invent grammar essays.${hint}

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
    }
    return `You are a ${langName}-Russian lexical assistant for a language reader. Analyze the selected ${langName} token in context. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|other), lemma, infinitive, surface, ru, gender (m|f|), level (A1|A2|B1|B2), tense, person, number, form_note, note. Rules: if the token is a conjugated ${langName} verb form, lemma and infinitive must be the infinitive; form_note must briefly explain what the surface form is (for example: "présent, ils/elles", "participe passé", "imparfait, je/il"). If the token is a noun and the language marks gender, give gender. If it is not a noun or verb, still give a short Russian meaning and lemma.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
  }

  if (task === 'translate_paragraph') {
    return `Translate this ${langName} paragraph into natural Russian for comprehension. Do not explain grammar unless needed. Return ONLY valid JSON: {"ru":"..."}.

TEXT:
${body.text || ''}`;
  }

  if (task === 'analyze_sentence') {
    if (lang === 'zh') {
      return `You are a Chinese grammar teacher for Russian-speaking learners (B1–C1 level).
Analyze the sentence below. Split it into 2–5 meaningful structural parts (not every word).
For each part explain WHAT it is and WHY it is here / why this grammar form is used.
Then pick 2–3 most interesting grammar points and explain WHY (the rule behind it), with a short parallel example.
Finally write one "суть" sentence: the key structural insight of the whole sentence.

Return ONLY valid JSON, no markdown:
{
  "parts": [
    {
      "zh": "meaningful chunk",
      "pinyin": "pinyin with tone marks",
      "what": "что это (на русском, 3–6 слов)",
      "why": "краткий русский перевод этой части"
    }
  ],
  "whys": [
    {
      "q": "Почему [конкретная форма]?",
      "a": "Объяснение правила на русском (1–2 предложения). Краткий пример: ..."
    }
  ],
  "summary": "Одно предложение о главной грамматической идее всего предложения."
}

Rules:
- parts: 2–5 items, merge short function words with adjacent content words
- whys: 2–3 items, only for genuinely non-obvious grammar (aspect markers, measure words, complements, 把/被, etc.)
- all text in "what", "a", "summary" must be in Russian
- keep everything concise

SENTENCE:
${body.text || ''}`;
    }
    if (lang === 'ja') {
      return `You are a Japanese grammar teacher for Russian-speaking learners (N4–N2 level).
Analyze the sentence below. Split it into 2–5 meaningful structural parts (not every word).
For each part explain WHAT it is and WHY it is here / why this grammar form is used.
Then pick 2–3 most interesting grammar points and explain WHY (the rule behind it), with a short parallel example.
Finally write one "суть" sentence: the key structural insight of the whole sentence.

Return ONLY valid JSON, no markdown:
{
  "parts": [
    {
      "ja": "meaningful chunk",
      "reading": "chunk in hiragana",
      "what": "что это (на русском, 3–6 слов)",
      "why": "краткий русский перевод этой части"
    }
  ],
  "whys": [
    {
      "q": "Почему [конкретная форма]?",
      "a": "Объяснение правила на русском (1–2 предложения). Краткий пример: ..."
    }
  ],
  "summary": "Одно предложение о главной грамматической идее всего предложения."
}

Rules:
- parts: 2–5 items, keep a particle with the phrase it marks (は / が / を / に / で), keep an auxiliary with its verb stem
- whys: 2–3 items, only for genuinely non-obvious grammar (て-формы, passive/causative, けいご, conditionals, nominalisation, topic vs subject, etc.)
- all text in "what", "a", "summary" must be in Russian
- keep everything concise

SENTENCE:
${body.text || ''}`;
    }
    return `You are a ${langName} grammar teacher for Russian-speaking learners (B1–C1 level).
Analyze the sentence below. Split it into 2–5 meaningful structural parts (not every word).
For each part explain WHAT it is and WHY it is here / why this grammar form is used.
Then pick 2–3 most interesting grammar points and explain WHY (the rule behind it), with a short parallel example.
Finally write one "суть" sentence: the key structural insight of the whole sentence.

Return ONLY valid JSON, no markdown:
{
  "parts": [
    {
      "fr": "meaningful chunk",
      "what": "что это (на русском, 3–6 слов)",
      "why": "краткий русский перевод этой части"
    }
  ],
  "whys": [
    {
      "q": "Почему [конкретная форма]?",
      "a": "Объяснение правила на русском (1–2 предложения). Краткий пример: ..."
    }
  ],
  "summary": "Одно предложение о главной грамматической идее всего предложения."
}

Rules:
- parts: 2–5 items, merge articles/prepositions with their noun/verb
- whys: 2–3 items, only for genuinely non-obvious grammar (subjonctif triggers, pronoun placement, relative clauses, agreement, etc.)
- all text in "what", "a", "summary" must be in Russian
- keep everything concise

SENTENCE:
${body.text || ''}`;
  }

  if (task === 'song_strophe') {
    return `You are a ${langName} language teacher helping a Russian-speaking learner understand song lyrics.
The learner wants to understand the MEANING and FEEL of this strophe — not a word-for-word translation.

Return ONLY valid JSON, no markdown:
{
  "meaning": "Свободный перевод строфы на русском — передай смысл и настроение, не буквально (2–4 предложения).",
  "notes": [
    {"phrase": "конкретная фраза из текста", "note": "что она значит — сленг, идиома, двойной смысл, культурная отсылка (1 предложение)"}
  ]
}

Rules:
- meaning: natural Russian, capture the emotion and subtext, not literal words
- notes: 1–3 items, only for genuinely non-obvious phrases (slang, idioms, cultural refs, wordplay). Skip obvious words.
- all output in Russian

STROPHE:
${body.text || ''}`;
  }

  if (task === 'generate_verb') {
    return `Generate a complete French verb card for a Russian-speaking learner.
Return ONLY valid JSON:
{
  "inf": "infinitive",
  "meaning": "Russian meaning",
  "group": "er|ir|re|irr (exactly one of these values, no hyphen)",
  "aux": "avoir|être (exactly one of these values)",
  "pp": "participe passé",
  "conj": {
    "present": ["je","tu","il/elle","nous","vous","ils/elles forms only, no pronouns"],
    "imparfait": ["6 forms"],
    "futur": ["6 forms"],
    "plus_que_parfait": ["6 forms, auxiliary + pp"],
    "conditionnel": ["6 forms"],
    "subjonctif": ["6 forms"],
    "imperatif": ["tu/nous/vous forms only, no pronouns"],
    "passe_simple": ["6 forms"]
  },
  "examples": {
    "present": "one short French example",
    "imparfait": "one short French example",
    "futur": "one short French example",
    "passe": "one short French example",
    "conditionnel": "one short French example",
    "subjonctif": "one short French example"
  }
}
Use the infinitive if the token is a conjugated form. Always set group as exactly er, ir, re, or irr. Always set aux as exactly avoir or être. Include all requested tenses even for common verbs.
TOKEN: ${body.word || body.infinitive || body.surface || ''}
CONTEXT: ${body.context || ''}`;
  }

  throw new HttpsError('invalid-argument', 'Unknown task');
}

function maxTokensForTask(task) {
  if (task === 'generate_verb') return 1400;
  if (task === 'analyze_sentence') return 900;
  if (task === 'song_strophe') return 500;
  if (task === 'fetch_url') return 0; // not an AI task
  return 450;
}

exports.readerAI = onCall(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 90,
    memory: '256MiB',
    secrets: [DEEPSEEK_API_KEY],
    cors: true,
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Нужно войти в Firebase Auth.');
    }

    const body = request.data || {};
    const task = String(body.task || '').trim();
    if (!task) throw new HttpsError('invalid-argument', 'Missing task');

    // fetch_url — не AI-задача, выполняем отдельно
    if (task === 'fetch_url') {
      const url = body.url || '';
      if (!url) throw new HttpsError('invalid-argument', 'No URL provided');
      let html = '';
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; An2Reader/1.0)' },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        html = await resp.text();
      } catch(e) {
        throw new HttpsError('internal', 'Не удалось загрузить страницу: ' + e.message);
      }
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 24000);
      return { text };
    }

    const userPrompt = buildPrompt(task, body);
    await enforceDailyLimit(request.auth.uid, task);

    const key = DEEPSEEK_API_KEY.value();
    if (!key) {
      throw new HttpsError('failed-precondition', 'Missing DEEPSEEK_API_KEY in Firebase Secret Manager. Run: firebase functions:secrets:set DEEPSEEK_API_KEY');
    }

    let response;
    try {
      response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          temperature: 0.1,
          max_tokens: maxTokensForTask(task),
          messages: [
            { role: 'system', content: 'Return only valid JSON. No markdown. No extra text.' },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
    } catch (error) {
      throw new HttpsError('unavailable', `DeepSeek network error: ${error?.message || String(error)}`);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.message || data?.error || `DeepSeek HTTP ${response.status}`;
      throw new HttpsError('internal', String(msg), data);
    }

    const content = data?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = extractJson(content);
    } catch (error) {
      throw new HttpsError('internal', `DeepSeek вернул не JSON: ${error?.message || String(error)}`, { content: String(content).slice(0, 1000) });
    }

    return { data: parsed };
  }
);

// ────────────────────────────────────────────────────────────────
// Cloud TTS proxy: Firebase Auth → Firebase Function → OpenRouter/Kokoro
// Raw MP3 is returned directly so the browser never sees OPENROUTER_API_KEY.
// No artificial daily limit is used here.
// ────────────────────────────────────────────────────────────────
const TTS_MAX_CHARS = 1800;
const TTS_MODEL = 'hexgrad/kokoro-82m';
// Default voice per language. Anything not listed here falls back to French,
// which is why every language the reader can speak needs an entry.
const TTS_VOICES = Object.freeze({
  fr: 'ff_siwis',
  zh: 'zf_xiaobei',
  ja: 'jf_alpha',
  en: 'af_heart',
  es: 'ef_dora',
});

function ttsLang(raw) {
  const v = String(raw || 'fr').trim().toLowerCase();
  if (v === 'zh' || v.startsWith('zh') || v === 'cn' || v === 'chinese') return 'zh';
  if (v === 'ja' || v.startsWith('ja-') || v === 'jp' || v === 'japanese') return 'ja';
  if (v === 'en' || v.startsWith('en-') || v === 'english') return 'en';
  if (v === 'es' || v.startsWith('es-') || v === 'spanish') return 'es';
  return 'fr';
}

function safeTtsSpeed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.7, Math.min(1.2, n));
}

function setTtsHeaders(res, extras = {}) {
  res.set({
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'Content-Type, X-TTS-Voice, X-TTS-Lang, X-Generation-Id',
    ...extras,
  });
}

async function verifyTtsRequest(req) {
  const header = String(req.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Нужно войти в Firebase Auth.');
  return admin.auth().verifyIdToken(match[1], true);
}

exports.ttsAudio = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 90,
    memory: '512MiB',
    secrets: [OPENROUTER_API_KEY],
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    }

    let user;
    try {
      user = await verifyTtsRequest(req);
    } catch (error) {
      return res.status(401).json({ error: 'unauthenticated', message: error?.message || 'Нужно войти в приложение.' });
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return res.status(400).json({ error: 'missing_text', message: 'Передай text.' });
    if (text.length > TTS_MAX_CHARS) {
      return res.status(400).json({ error: 'text_too_long', message: `Максимум ${TTS_MAX_CHARS} символов за один запрос.` });
    }

    const lang = ttsLang(req.body?.lang);
    const requestedVoice = typeof req.body?.voice === 'string' ? req.body.voice.trim() : '';
    // Voices are server-controlled by language. This prevents a French voice
    // accidentally receiving Chinese text and keeps the UI deterministic.
    const voice = requestedVoice || TTS_VOICES[lang];
    const speed = safeTtsSpeed(req.body?.speed ?? req.body?.rate);
    const key = OPENROUTER_API_KEY.value();
    if (!key) {
      return res.status(500).json({ error: 'missing_openrouter_key', message: 'В Firebase Secret Manager не задан OPENROUTER_API_KEY.' });
    }

    let upstream;
    try {
      upstream = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          input: text,
          voice,
          response_format: 'mp3',
          speed,
        }),
      });
    } catch (error) {
      return res.status(503).json({ error: 'openrouter_unavailable', message: `OpenRouter network error: ${error?.message || String(error)}` });
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return res.status(502).json({
        error: 'openrouter_tts_failed',
        message: `OpenRouter TTS HTTP ${upstream.status}`,
        detail: detail.slice(0, 1000),
      });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    if (audio.length < 200) {
      return res.status(502).json({ error: 'empty_audio', message: 'OpenRouter вернул слишком короткое аудио.' });
    }

    // A lightweight usage counter, never a blocking quota.
    try {
      await admin.database().ref(`ai_usage/${user.uid}/${todayKey()}/tts_audio_chars`).transaction((current) => Number(current || 0) + text.length);
    } catch (_) {}

    setTtsHeaders(res, {
      'X-TTS-Voice': voice,
      'X-TTS-Lang': lang,
      'X-Generation-Id': upstream.headers.get('x-generation-id') || '',
    });
    return res.status(200).send(audio);
  }
);


const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
// Groq direct (not via OpenRouter) — OpenRouter's unified /audio/transcriptions
// endpoint accepts response_format/timestamp_granularities without error but
// silently never returns segments (confirmed empirically), regardless of model
// or provider routing. Groq's own native (OpenAI-compatible) Whisper endpoint
// reliably supports verbose_json + segment timestamps per their docs.
const GROQ_API_KEY = defineSecret('GROQ_API_KEY');

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


function sourceLang(body) {
  const raw = String(body?.sourceLang || body?.lang || 'fr').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn' || raw === 'chinese') return 'zh';
  if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en';
  return 'fr';
}

function sourceLangName(code) {
  return code === 'zh' ? 'Chinese' : code === 'en' ? 'English' : 'French';
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
    if (lang === 'en') {
      return `You are an English-Russian lexical assistant for a language reader. Analyze the selected English token in context. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|other), lemma, ru, level (A1|A2|B1|B2), form_note, note. Rules: lemma is the base/infinitive form; ru must be a short natural Russian meaning; form_note briefly explains the form if it is inflected (e.g. "past tense", "plural", "3rd person singular"). No gender needed.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
    }
    return `You are a French-Russian lexical assistant for a language reader. Analyze the selected French token in context. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|other), lemma, infinitive, surface, ru, gender (m|f|), level (A1|A2|B1|B2), tense, person, number, form_note, note. Rules: if the token is a conjugated French verb form, lemma and infinitive must be the infinitive; form_note must briefly explain what the surface form is (for example: "présent, ils/elles", "participe passé", "imparfait, je/il"). If the token is a noun, give gender. If it is not a noun or verb, still give a short Russian meaning and lemma.

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
    if (lang === 'en') {
      return `You are an English grammar teacher for Russian-speaking learners (B1–C1 level).
Analyze the sentence below. Split it into 2–5 meaningful structural parts (not every word).
For each part explain WHAT it is and WHY it is here / why this grammar form is used.
Then pick 2–3 most interesting grammar points and explain WHY (the rule behind it), with a short parallel example.
Finally write one "суть" sentence: the key structural insight of the whole sentence.

Return ONLY valid JSON, no markdown:
{
  "parts": [
    {
      "en": "meaningful chunk",
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
- parts: 2–5 items, merge auxiliaries/articles/prepositions with their main word
- whys: 2–3 items, only for genuinely non-obvious grammar (perfect vs continuous, conditionals, passive voice, inversion, etc.)
- all text in "what", "a", "summary" must be in Russian
- keep everything concise

SENTENCE:
${body.text || ''}`;
    }
    return `You are a French grammar teacher for Russian-speaking learners (B1–C1 level).
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
    const langName = lang === 'zh' ? 'Chinese' : 'French';
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

  if (task === 'clean_transcript') {
    const zhNote = lang === 'zh'
      ? ` The raw transcript has NO punctuation at all (Whisper does not add any for Chinese) — you must add standard Chinese punctuation (。，！？、) based on meaning and natural pauses, not just copy it as one block. Whisper also randomly mixes Traditional and Simplified characters within the same transcript (it has no fixed script mode) — normalize ALL output to Simplified Chinese (简体字), converting any Traditional characters you see.`
      : '';
    return `You are cleaning up a raw speech-to-text transcript of spoken ${langName} for a language-learning reader app. Fix ASR mistakes (misheard homophones, wrong characters/words, missing punctuation), and split the text into natural paragraphs of roughly 2-5 sentences each — do this even if the raw text has no punctuation or paragraph cues at all; use topic shifts and natural pauses in meaning to decide where a paragraph ends. Never return the whole input as a single unbroken block.${zhNote} Do NOT translate, summarize, or change the meaning — only clean up recognition errors and add punctuation/paragraph breaks.
Return ONLY valid JSON:
{
  "text": "cleaned transcript here, with paragraphs separated by a blank line (\\n\\n)"
}

RAW TRANSCRIPT:
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
  if (task === 'clean_transcript') return 4000;
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
const TTS_VOICES = Object.freeze({
  fr: 'ff_siwis',
  zh: 'zf_xiaobei',
  en: 'af_heart',
});

function ttsLang(raw) {
  const v = String(raw || 'fr').trim().toLowerCase();
  if (v === 'zh' || v.startsWith('zh') || v === 'cn' || v === 'chinese') return 'zh';
  if (v === 'en' || v.startsWith('en-') || v === 'english') return 'en';
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

// ────────────────────────────────────────────────────────────────
// Audio transcription proxy: Firebase Auth → Firebase Function → Groq (Whisper).
// Direct to Groq, not via OpenRouter: OpenRouter's unified JSON endpoint
// accepts response_format/timestamp_granularities without error but never
// actually returns segments (confirmed empirically), regardless of model or
// provider routing — Groq's own (OpenAI-compatible) endpoint reliably gives
// per-segment timestamps, which paragraph-to-audio sync needs.
// Client sends base64 audio; GROQ_API_KEY never reaches the browser.
// ────────────────────────────────────────────────────────────────
// Raw audio must stay well under Whisper's 25MB cap; base64 adds ~33% overhead.
const STT_MAX_BASE64_CHARS = 30_000_000; // ~22MB raw audio

exports.transcribeAudio = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 180,
    memory: '512MiB',
    secrets: [GROQ_API_KEY],
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

    const audioBase64 = typeof req.body?.audioBase64 === 'string' ? req.body.audioBase64 : '';
    const format = typeof req.body?.format === 'string' && req.body.format.trim() ? req.body.format.trim() : 'mp3';
    const lang = typeof req.body?.lang === 'string' ? req.body.lang.trim().toLowerCase() : '';
    if (!audioBase64) return res.status(400).json({ error: 'missing_audio', message: 'Передай audioBase64.' });
    if (audioBase64.length > STT_MAX_BASE64_CHARS) {
      return res.status(400).json({ error: 'audio_too_large', message: 'Файл слишком большой (лимит ~20 МБ). Сожми битрейт или обрежь файл.' });
    }

    const key = GROQ_API_KEY.value();
    if (!key) {
      return res.status(500).json({ error: 'missing_groq_key', message: 'В Firebase Secret Manager не задан GROQ_API_KEY.' });
    }

    // Groq's transcription endpoint takes multipart/form-data, not JSON —
    // that's a different shape than OpenRouter's unified API used elsewhere here.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: `audio/${format}` }), `audio.${format}`);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (lang) form.append('language', lang);

    let upstream;
    try {
      upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    } catch (error) {
      return res.status(503).json({ error: 'groq_unavailable', message: `Groq network error: ${error?.message || String(error)}` });
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return res.status(502).json({
        error: 'groq_stt_failed',
        message: `Groq STT HTTP ${upstream.status}`,
        detail: detail.slice(0, 1000),
      });
    }

    const data = await upstream.json().catch(() => ({}));
    const text = data?.text || '';
    if (!text) return res.status(502).json({ error: 'empty_transcript', message: 'Groq вернул пустой транскрипт.' });

    const segments = (Array.isArray(data?.segments) ? data.segments : [])
      .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
      .filter(s => s.text);

    try {
      await admin.database().ref(`ai_usage/${user.uid}/${todayKey()}/transcribe_audio_chars`).transaction((current) => Number(current || 0) + text.length);
    } catch (_) {}

    return res.status(200).json({ text, segments });
  }
);

// ────────────────────────────────────────────────────────────────
// Live radio stream capture proxy: Firebase Auth → Firebase Function → stream URL.
// Recording programmatically in the browser needs the stream server to send
// permissive CORS headers, and most icecast/shoutcast stations don't. A
// server-to-server fetch has no CORS restriction at all, so the function reads
// the stream itself for a bounded duration and hands the captured bytes back
// as a normal audio file — the client then feeds it through the exact same
// decode/chunk/transcribe/cleanup pipeline used for uploaded files.
// ────────────────────────────────────────────────────────────────
// These aren't product choices, they're the actual platform ceiling: Cloud Run
// (2nd gen Firebase Functions) hard-caps a single HTTP request/response at 32MB
// and a function invocation at 3600s. Stay just under both.
const RADIO_MAX_RECORD_SECONDS = 3540; // 59 min — leaves headroom under the 3600s invocation ceiling
const RADIO_MAX_RECORD_BYTES = 28 * 1024 * 1024; // leaves headroom under the 32MB response ceiling

function isHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

exports.recordRadioStream = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 3600, // Cloud Run's actual max for 2nd gen HTTP functions
    memory: '512MiB',
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

    const streamUrl = typeof req.body?.streamUrl === 'string' ? req.body.streamUrl.trim() : '';
    if (!streamUrl || !isHttpUrl(streamUrl)) {
      return res.status(400).json({ error: 'invalid_url', message: 'Передай корректную http(s) ссылку на аудиопоток.' });
    }
    // No client-chosen duration anymore — the normal way to end a recording is the
    // client aborting this request (its "stop" button). This is just a backstop so
    // a forgotten tab doesn't run (and bill) forever.
    const durationSeconds = RADIO_MAX_RECORD_SECONDS;

    let upstream;
    try {
      upstream = await fetch(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; An2Reader/1.0)' } });
    } catch (error) {
      return res.status(503).json({ error: 'stream_unavailable', message: `Не удалось подключиться к потоку: ${error?.message || String(error)}` });
    }
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'stream_http_error', message: `Поток вернул HTTP ${upstream.status}` });
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.flushHeaders?.();

    let totalBytes = 0;
    let clientGone = false;
    // Fires when the client aborts its fetch (our "stop" button) — lets us stop
    // reading upstream immediately instead of burning the full backstop duration.
    req.on('close', () => { clientGone = true; });

    const deadline = Date.now() + durationSeconds * 1000;
    const reader = upstream.body.getReader();
    try {
      while (!clientGone && Date.now() < deadline && totalBytes < RADIO_MAX_RECORD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break; // stream ended on its own (e.g. a finite clip, not a live loop)
        totalBytes += value.byteLength;
        res.write(Buffer.from(value));
      }
    } catch (_) {
      // client aborted mid-read, or upstream hiccuped — we already streamed
      // whatever arrived before this, which is exactly what "stop" should keep.
    } finally {
      try { await reader.cancel(); } catch (_) {}
    }

    try {
      await admin.database().ref(`ai_usage/${user.uid}/${todayKey()}/radio_record_bytes`).transaction((current) => Number(current || 0) + totalBytes);
    } catch (_) {}

    if (!res.writableEnded) res.end();
  }
);


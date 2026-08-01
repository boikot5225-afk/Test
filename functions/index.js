const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { resolveDeepSeekModel } = require('./deepseek-model');
const {
  buildDeepSeekJsonRequest,
  deepSeekMessageContent,
  deepSeekFinishReason,
} = require('./deepseek-json');

const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
// Optional self-hosted Kokoro TTS + faster-whisper STT (see selfhost/ in the
// repo). When both are set, ttsAudio/transcribeAudio try this first and only
// fall back to OpenRouter if it's unreachable — free per-request once the
// VPS is already paid for something else, OpenRouter stays as a safety net.
const SELFHOST_TTS_STT_URL = defineSecret('SELFHOST_TTS_STT_URL');
const SELFHOST_TOKEN = defineSecret('SELFHOST_TOKEN');

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app';
if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: DATABASE_URL });
}

// Live-probed (2026-07-08) against OpenRouter's audio/speech endpoint — every
// candidate Kokoro voice id below (fr/en-US/en-UK/zh/es) came back 200 OK, so
// the full Kokoro voicepack is genuinely available through this project's
// key. That's what backs js/tts.js's KOKORO_VOICES picker.
//
// Separately, a TTS *model* (not voice) probe against the same endpoint
// (2026-07-08, see git history for the temp diagnostic code) established
// what's actually callable with this key, despite what OpenRouter's docs say:
//   openai/gpt-4o-mini-tts (+ dated variant, + bare, + tts-1) → 400 "does not exist"
//   mistralai/voxtral-mini-tts-2603 → provider 404
//   google/gemini-3.1-flash-tts-preview → EXISTS (but requires response_format:"pcm")
//   hexgrad/kokoro-82m → works (in production use)
// So the only real better-quality upgrade path via OpenRouter is Gemini
// Flash TTS with PCM output — GPT-4o Mini TTS is simply not available here.

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
  if (raw === 'es' || raw.startsWith('es-') || raw === 'spanish') return 'es';
  return 'fr';
}

function sourceLangName(code) {
  return code === 'zh' ? 'Chinese' : code === 'en' ? 'English' : code === 'es' ? 'Spanish' : 'French';
}

function buildPrompt(task, body) {
  const lang = sourceLang(body);
  const langName = sourceLangName(lang);

  if (task === 'reader_word') {
    if (lang === 'zh') {
      return `You are a Chinese-Russian lexical assistant for a language reader. Analyze the selected Chinese token in context. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|particle|measure_word|proper_noun|other), lemma, surface, pinyin, ru, level (HSK1|HSK2|HSK3|HSK4|HSK5|HSK6|unknown), form_note, note, chars. Rules: pinyin must use tone marks; ru must be short and natural Russian; if the token is a name or place, mark proper_noun; do not invent grammar essays. "chars" is a compact per-character breakdown so a learner can see how the word is built — REQUIRED when the token has 2+ characters (leave "" for a single character): one Chinese character, its own pinyin, and 1-2 Russian words for its own meaning, joined like "甚(shén)очень + 至(zhì)доходить" — no full sentences, no repeating the whole-word translation, keep the entire field under ~80 characters even for 4+ character words.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
    }
    if (lang === 'en') {
      return `You are an English-Russian lexical assistant for a language reader. Analyze the selected English token IN ITS CONTEXT. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|other), lemma, ru, level (A1|A2|B1|B2), form_note, note, ipa. Rules: lemma is the base/infinitive form; ru must be the meaning of the token AS USED IN THIS SPECIFIC CONTEXT, not the most common dictionary sense — if the token is part of an idiom or phrasal verb (e.g. "road" in "get the show on the road", "up" in "give up"), ru gives the contextual meaning and note names the idiom/phrasal verb with its Russian meaning (e.g. "get the show on the road — начать, приступить к делу"); form_note briefly explains the form if it is inflected (e.g. "past tense", "plural", "3rd person singular"). "ipa" is the standard IPA phonetic transcription of the SURFACE token (the word as it actually appears, not the lemma) in General American pronunciation, wrapped in slashes, e.g. "/prəˈnaʊnst/" — always fill this in. No gender needed.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
    }
    if (lang === 'es') {
      return `You are a Spanish-Russian lexical assistant for a language reader. Analyze the selected Spanish token IN ITS CONTEXT. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|other), lemma, infinitive, surface, ru, gender (m|f|), level (A1|A2|B1|B2), tense, person, number, form_note, note. Rules: if the token is a conjugated Spanish verb form, lemma and infinitive must be the infinitive; form_note must briefly explain what the surface form is (for example: "presente, ellos/ellas", "pretérito indefinido, yo", "subjuntivo presente, tú", "gerundio", "participio"). Reflexive verbs (e.g. "se levanta") must give the infinitive with "-se" (e.g. "levantarse"). If the token is a noun, give gender (el → m, la → f). ru must reflect the meaning AS USED IN THIS CONTEXT — if the token is part of an idiom or fixed expression, ru gives the contextual meaning and note names the expression with its Russian meaning. If it is not a noun or verb, still give a short Russian meaning and lemma.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
    }
    return `You are a French-Russian lexical assistant for a language reader. Analyze the selected French token IN ITS CONTEXT. Return ONLY valid JSON with keys: pos (noun|verb|adjective|adverb|preposition|pronoun|other), lemma, infinitive, surface, ru, gender (m|f|), level (A1|A2|B1|B2), tense, person, number, form_note, note. Rules: if the token is a conjugated French verb form, lemma and infinitive must be the infinitive; form_note must briefly explain what the surface form is (for example: "présent, ils/elles", "participe passé", "imparfait, je/il"). If the token is a noun, give gender. ru must reflect the meaning AS USED IN THIS CONTEXT — if the token is part of an idiom or fixed expression, ru gives the contextual meaning and note names the expression with its Russian meaning. If it is not a noun or verb, still give a short Russian meaning and lemma.

TOKEN: ${body.word || body.surface || ''}
CONTEXT: ${body.context || ''}`;
  }

  if (task === 'translate_paragraph') {
    return `Translate this ${langName} paragraph into natural Russian for comprehension. Do not explain grammar unless needed.

Slang, insults, ethnic nicknames, and idioms must be translated by their ACTUAL MEANING as used in context, never word-for-word by root/etymology. For example "frijolero" is a slang/derogatory nickname for Mexicans, not a word about beans — translate it as the real-world equivalent (e.g. "мексиканец" or a fitting Russian slang/derogatory equivalent), not literally. If unsure of the real meaning of a slang term, prefer a natural contextual guess over a literal mistranslation.

Return ONLY valid JSON: {"ru":"..."}.

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
    if (lang === 'es') {
      return `You are a Spanish grammar teacher for Russian-speaking learners (B1–C1 level).
Analyze the sentence below. Split it into 2–5 meaningful structural parts (not every word).
For each part explain WHAT it is and WHY it is here / why this grammar form is used.
Then pick 2–3 most interesting grammar points and explain WHY (the rule behind it), with a short parallel example.
Finally write one "суть" sentence: the key structural insight of the whole sentence.

Return ONLY valid JSON, no markdown:
{
  "parts": [
    {
      "es": "meaningful chunk",
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
- whys: 2–3 items, only for genuinely non-obvious grammar (ser vs estar, subjuntivo triggers, clitic/pronoun placement, por vs para, etc.)
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
    // English ASR-specific quirks Whisper reliably gets wrong that the generic
    // "fix ASR mistakes" instruction alone wasn't reliably catching: spoken
    // filler/disfluency clutter (especially thick in podcasts/talk audio) and
    // classic homophone confusions.
    const enNote = lang === 'en'
      ? ` This is spoken English (often casual — podcasts, interviews, talk audio), so also: remove pure filler/disfluency words and false starts (um, uh, "you know", "like" used as a verbal tic, stuttered word repeats such as "I- I- I think") that add no meaning — but keep genuine repetition used for emphasis (e.g. "no, no, no" as a real reaction). Fix classic English ASR homophone mix-ups (their/there/they're, its/it's, your/you're, to/too/two, effect/affect) based on context. Capitalize proper nouns and sentence starts correctly.`
      : '';
    return `You are cleaning up a raw speech-to-text transcript of spoken ${langName} for a language-learning reader app. Fix ASR mistakes (misheard homophones, wrong characters/words, missing punctuation), and split the text into natural paragraphs of roughly 2-5 sentences each — do this even if the raw text has no punctuation or paragraph cues at all; use topic shifts and natural pauses in meaning to decide where a paragraph ends. Never return the whole input as a single unbroken block.${zhNote}${enNote} Do NOT translate, summarize, or change the meaning — only clean up recognition errors and add punctuation/paragraph breaks.
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

  if (task === 'reverse_lookup') {
    return `The learner is trying to think in ${langName} but can't recall or doesn't know the exact word for a concept they can only describe in Russian. Given their Russian description below, suggest the ${langName} word(s) or short phrase(s) that best express it.

Return ONLY valid JSON, no markdown:
{
  "suggestions": [
    {"word": "...", "note": "1 short sentence in Russian: when/why to use this one, or how it differs from the other options"}
  ]
}

Rules:
- suggestions: 2-4 items, ordered by how well they fit
- if there's a clearly single correct word, still give 1-2 close alternatives/synonyms and explain the nuance
- "word" is just the ${langName} word or short phrase itself — no translation, no article unless essential to the meaning
- note must be in Russian, concise and practical, not a dictionary definition

RUSSIAN DESCRIPTION:
${body.query || body.text || ''}`;
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

function requireReaderTaskInput(task, body) {
  const textTasks = new Set([
    'translate_paragraph',
    'analyze_sentence',
    'song_strophe',
    'clean_transcript',
  ]);
  if (textTasks.has(task) && !String(body?.text || '').trim()) {
    throw new HttpsError('invalid-argument', `Для задачи ${task} не передан текст.`);
  }
  if (task === 'reader_word' && !String(body?.word || body?.surface || '').trim()) {
    throw new HttpsError('invalid-argument', 'Для разбора не передано слово.');
  }
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

    requireReaderTaskInput(task, body);
    const userPrompt = buildPrompt(task, body);
    await enforceDailyLimit(request.auth.uid, task);

    const key = DEEPSEEK_API_KEY.value();
    if (!key) {
      throw new HttpsError('failed-precondition', 'Missing DEEPSEEK_API_KEY in Firebase Secret Manager. Run: firebase functions:secrets:set DEEPSEEK_API_KEY');
    }

    const requestBody = buildDeepSeekJsonRequest({
      // DeepSeek retired the legacy deepseek-chat/deepseek-reasoner aliases
      // on 2026-07-24. Normalize even a stale environment override so an
      // old DEEPSEEK_MODEL value cannot randomly break warm instances.
      model: resolveDeepSeekModel(),
      maxTokens: maxTokensForTask(task),
      userPrompt,
    });

    let parsed;
    let lastContent = '';
    let lastFinishReason = '';
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      let response;
      try {
        response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        if (attempt === 0) continue;
        throw new HttpsError('unavailable', `DeepSeek network error: ${error?.message || String(error)}`);
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = data?.error?.message || data?.error || `DeepSeek HTTP ${response.status}`;
        throw new HttpsError('internal', String(msg), data);
      }

      lastContent = deepSeekMessageContent(data);
      lastFinishReason = deepSeekFinishReason(data);
      if (!lastContent) continue;
      try {
        parsed = extractJson(lastContent);
      } catch (_) {
        // JSON mode should make this exceptionally rare. Retry once so one
        // malformed provider response does not break the reader interaction.
      }
    }

    if (!parsed) {
      throw new HttpsError(
        'internal',
        `DeepSeek не вернул готовый JSON${lastFinishReason ? ` (finish_reason: ${lastFinishReason})` : ''}.`,
        { content: lastContent.slice(0, 1000), finishReason: lastFinishReason }
      );
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
// Two selectable voice engines (client picks via body.engine, defaults to
// 'kokoro'): Kokoro is free-ish and already in use; GPT-4o Mini TTS is a
// noticeably more natural voice for roughly 4x the per-character cost —
// still a fraction of a cent per paragraph, cheap enough to offer as an
// upgrade rather than a wholesale replacement. GPT-4o's TTS is multilingual
// per-voice (it infers pronunciation from the input text), so one voice
// covers all reader languages instead of Kokoro's per-language voice IDs.
const TTS_ENGINES = Object.freeze({
  kokoro: {
    model: 'hexgrad/kokoro-82m',
    voices: { fr: 'ff_siwis', zh: 'zf_xiaobei', en: 'af_heart', es: 'ef_dora' },
  },
  gpt4o: {
    // Dated/versioned slug — OpenRouter's audio/speech endpoint 502s on the
    // unversioned "openai/gpt-4o-mini-tts" (confirmed in Cloud Function logs).
    model: 'openai/gpt-4o-mini-tts-2025-12-15',
    voices: { fr: 'alloy', zh: 'alloy', en: 'alloy', es: 'alloy' },
  },
});

function ttsEngineName(raw) {
  return String(raw || 'kokoro').trim().toLowerCase() === 'gpt4o' ? 'gpt4o' : 'kokoro';
}

function ttsLang(raw) {
  const v = String(raw || 'fr').trim().toLowerCase();
  if (v === 'zh' || v.startsWith('zh') || v === 'cn' || v === 'chinese') return 'zh';
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
    'Access-Control-Expose-Headers': 'Content-Type, X-TTS-Voice, X-TTS-Lang, X-TTS-Engine, X-Generation-Id',
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
    secrets: [OPENROUTER_API_KEY, SELFHOST_TTS_STT_URL, SELFHOST_TOKEN],
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
    const engine = ttsEngineName(req.body?.engine);
    const engineConf = TTS_ENGINES[engine];
    const requestedVoice = typeof req.body?.voice === 'string' ? req.body.voice.trim() : '';
    // Voices are server-controlled by language. This prevents a French voice
    // accidentally receiving Chinese text and keeps the UI deterministic.
    const voice = requestedVoice || engineConf.voices[lang] || engineConf.voices.en;
    const speed = safeTtsSpeed(req.body?.speed ?? req.body?.rate);

    let audio = null;
    let mimeType = 'audio/mpeg';
    let usedSelfhost = false;
    let generationId = '';

    // Try the self-hosted VPS first (Kokoro only — that's what runs there),
    // only when both secrets are actually configured. Falls through to
    // OpenRouter below on any failure, so a self-host outage never breaks
    // listening entirely.
    const selfhostUrl = SELFHOST_TTS_STT_URL.value();
    const selfhostToken = SELFHOST_TOKEN.value();
    if (engine === 'kokoro' && selfhostUrl && selfhostToken) {
      try {
        const r = await fetch(`${selfhostUrl.replace(/\/$/, '')}/v1/audio/speech`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${selfhostToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: engineConf.model, input: text, voice, response_format: 'wav', speed }),
          signal: AbortSignal.timeout(45000),
        });
        if (r.ok) {
          audio = Buffer.from(await r.arrayBuffer());
          mimeType = r.headers.get('content-type') || 'audio/wav';
          usedSelfhost = true;
        } else {
          console.warn(`[ttsAudio] self-host ${r.status}, falling back to OpenRouter`);
        }
      } catch (error) {
        console.warn('[ttsAudio] self-host unreachable, falling back to OpenRouter:', error?.message || error);
      }
    }

    if (!audio) {
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
            model: engineConf.model,
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
        console.error(`[ttsAudio] OpenRouter ${upstream.status} for engine=${engine} model=${engineConf.model} voice=${voice}: ${detail.slice(0, 500)}`);
        return res.status(502).json({
          error: 'openrouter_tts_failed',
          message: `OpenRouter TTS HTTP ${upstream.status}`,
          detail: detail.slice(0, 1000),
        });
      }

      audio = Buffer.from(await upstream.arrayBuffer());
      mimeType = upstream.headers.get('content-type') || 'audio/mpeg';
      generationId = upstream.headers.get('x-generation-id') || '';
    }

    if (audio.length < 200) {
      return res.status(502).json({ error: 'empty_audio', message: 'Пустое аудио от бэкенда озвучки.' });
    }

    // A lightweight usage counter, never a blocking quota — split by engine,
    // and self-host calls are tracked separately since they cost nothing.
    try {
      const counterEngine = usedSelfhost ? `${engine}_selfhost` : engine;
      await admin.database().ref(`ai_usage/${user.uid}/${todayKey()}/tts_audio_chars_${counterEngine}`).transaction((current) => Number(current || 0) + text.length);
    } catch (_) {}

    setTtsHeaders(res, {
      'Content-Type': mimeType,
      'X-TTS-Voice': voice,
      'X-TTS-Lang': lang,
      'X-TTS-Engine': usedSelfhost ? `${engine}-selfhost` : engine,
      'X-Generation-Id': generationId,
    });
    return res.status(200).send(audio);
  }
);

// ────────────────────────────────────────────────────────────────
// Audio transcription proxy: Firebase Auth → Firebase Function → OpenRouter (Whisper).
// Client sends base64 audio; OPENROUTER_API_KEY never reaches the browser.
// Note: OpenRouter's unified endpoint never returns segment timestamps
// regardless of model/provider (confirmed empirically) — the client degrades
// gracefully to plain text without paragraph-to-audio sync when segments
// come back empty.
// ────────────────────────────────────────────────────────────────
const STT_MODEL = 'openai/whisper-large-v3';
// Raw audio must stay well under OpenRouter/Whisper's 25MB cap; base64 adds ~33% overhead.
const STT_MAX_BASE64_CHARS = 30_000_000; // ~22MB raw audio

exports.transcribeAudio = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 180,
    memory: '512MiB',
    secrets: [OPENROUTER_API_KEY, SELFHOST_TTS_STT_URL, SELFHOST_TOKEN],
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

    let data = null;
    let usedSelfhost = false;

    const selfhostUrl = SELFHOST_TTS_STT_URL.value();
    const selfhostToken = SELFHOST_TOKEN.value();
    if (selfhostUrl && selfhostToken) {
      try {
        const r = await fetch(`${selfhostUrl.replace(/\/$/, '')}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${selfhostToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input_audio: { data: audioBase64, format },
            ...(lang ? { language: lang } : {}),
            response_format: 'verbose_json',
            timestamp_granularities: ['segment'],
          }),
          signal: AbortSignal.timeout(150000),
        });
        if (r.ok) {
          data = await r.json().catch(() => ({}));
          usedSelfhost = true;
        } else {
          console.warn(`[transcribeAudio] self-host ${r.status}, falling back to OpenRouter`);
        }
      } catch (error) {
        console.warn('[transcribeAudio] self-host unreachable, falling back to OpenRouter:', error?.message || error);
      }
    }

    if (!data) {
      const key = OPENROUTER_API_KEY.value();
      if (!key) {
        return res.status(500).json({ error: 'missing_openrouter_key', message: 'В Firebase Secret Manager не задан OPENROUTER_API_KEY.' });
      }

      let upstream;
      try {
        upstream = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: STT_MODEL,
            input_audio: { data: audioBase64, format },
            ...(lang ? { language: lang } : {}),
            response_format: 'verbose_json',
            timestamp_granularities: ['segment'],
          }),
        });
      } catch (error) {
        return res.status(503).json({ error: 'openrouter_unavailable', message: `OpenRouter network error: ${error?.message || String(error)}` });
      }

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return res.status(502).json({
          error: 'openrouter_stt_failed',
          message: `OpenRouter STT HTTP ${upstream.status}`,
          detail: detail.slice(0, 1000),
        });
      }

      data = await upstream.json().catch(() => ({}));
    }

    const text = data?.text || data?.transcript || data?.transcription || '';
    if (!text) return res.status(502).json({ error: 'empty_transcript', message: 'Пустой транскрипт от бэкенда распознавания.' });

    // Not every provider/model actually honors timestamp_granularities — degrade
    // gracefully to plain text (no sync) rather than fail the whole request.
    const segments = Array.isArray(data?.segments)
      ? data.segments
        .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
        .filter(s => s.text)
      : [];

    try {
      const counterEngine = usedSelfhost ? 'transcribe_audio_chars_selfhost' : 'transcribe_audio_chars';
      await admin.database().ref(`ai_usage/${user.uid}/${todayKey()}/${counterEngine}`).transaction((current) => Number(current || 0) + text.length);
    } catch (_) {}

    return res.status(200).json({ text, segments, engine: usedSelfhost ? 'selfhost' : 'openrouter' });
  }
);

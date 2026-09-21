'use strict';

const MAX_CONTEXT_CHARS = 1800;
const MAX_TARGETS = 24;
const GERMAN_LETTER = /[A-Za-zÄÖÜäöüß]/u;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeRu(value) {
  const text = clean(value, 48)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?…]+$/g, '')
    .trim();
  if (!/[Ѐ-ԯ]/u.test(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return '';
  return text;
}

function target(raw, index) {
  const surface = clean(raw?.surface || raw?.word, 48);
  if (!surface || !GERMAN_LETTER.test(surface)) return null;
  const senses = Array.isArray(raw?.senses)
    ? raw.senses.map(safeRu).filter(Boolean).slice(0, 8)
    : [];
  return {
    id: clean(raw?.id || `t${index}`, 40) || `t${index}`,
    surface,
    lemma: clean(raw?.lemma, 48),
    localRu: safeRu(raw?.localRu),
    // Разбор составного слова, сделанный на устройстве по таблицам
    // Викисловаря. Модели он нужен как подсказка: Haustür нет ни в одном
    // словаре, а Haus и Tür есть.
    parts: Array.isArray(raw?.parts) ? raw.parts.map(item => clean(item, 32)).filter(Boolean).slice(0, 4) : [],
    senses,
  };
}

function buildDeContextBatchPrompt(body = {}) {
  const context = clean(body.context, MAX_CONTEXT_CHARS);
  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .slice(0, MAX_TARGETS)
    .map(target)
    .filter(Boolean);
  if (!context || !GERMAN_LETTER.test(context)) {
    throw new Error('Нужен немецкий context.');
  }
  if (!targets.length) throw new Error('Нет German Unknown targets.');
  const ids = new Set();
  for (const item of targets) {
    if (ids.has(item.id)) throw new Error('Повторяющийся target id.');
    ids.add(item.id);
  }

  return `You are the contextual German->Russian inline-gloss engine for a book reader.

You receive ONE exact German paragraph and token OCCURRENCES currently marked Unknown. The reader has ALREADY shown an offline WikDict gloss. Your job is to replace it only when the exact paragraph makes a different meaning genuinely clear.

For every target return:
- id: copy exactly;
- ru: short natural Russian gloss for THIS occurrence, normally 1-4 words;
- lemma: German dictionary form, written as in a dictionary (nouns capitalised);
- pos: noun|verb|adjective|adverb|pronoun|preposition|conjunction|particle|proper_noun|other;
- confidence: number 0..1;
- note: optional very short Russian phrase for a fixed expression, a separable verb or a compound, otherwise "".

STRICT RULES:
1. Context wins over the first dictionary sense, but localRu/senses/parts are useful offline hints. Do NOT change a plausible local gloss merely to sound different.
2. Be conservative with confidence. Use >=0.90 only when the paragraph makes the intended Russian sense genuinely clear. Ambiguity or insufficient context must stay below 0.90 so the client keeps WikDict.
3. A capital letter is NOT evidence of a name. Every German noun is capitalised — Haus, Stunde, Freiheit are ordinary words. A proper name is a person, place or brand: Berlin, München, Müller, Goethe, Rhein. Only for those set pos="proper_noun", ru="" and a high confidence so the reader stops glossing them.
4. Separable verbs are one word split across the sentence: in "er steht früh auf" the target "steht" belongs to aufstehen ("вставать"), not to stehen. Gloss the meaning of the whole verb and name it in note. The same for "gibt … auf", "fängt … an", "hört … zu".
5. A compound noun is glossed as the whole word — Haustür is "входная дверь", not "дом + дверь". Use parts only to work out the meaning, and if the word is transparent and the gloss obvious, keep it short.
6. Cases and prepositions change the meaning: "in die Stadt" (куда) against "in der Stadt" (где), "vor einem Jahr" (год назад). Gloss the token as it works in this sentence.
7. Preserve distinctions German spelling hides: Bank is "скамейка" or "банк"; Schloss is "замок" (строение) or "замок" (запор) — say which in note; Gericht is "суд" or "блюдо"; Zug is "поезд", "тяга" or "ход"; See is "озеро" (m) or "море" (f); Ton is "звук" or "глина".
8. Modal particles (doch, ja, mal, eben, halt, schon) often carry no lexical meaning of their own. Do not invent one: give the shade of meaning if the sentence makes it clear, otherwise keep confidence low.
9. Return one item for EVERY supplied id, with no missing or extra ids.
10. Return ONLY JSON with this exact top-level shape:
{"items":[{"id":"t0","ru":"...","lemma":"...","pos":"noun","confidence":0.95,"note":""}]}

CONTEXT:
${context}

TARGETS:
${JSON.stringify(targets)}`;
}

module.exports = { buildDeContextBatchPrompt, MAX_CONTEXT_CHARS, MAX_TARGETS };

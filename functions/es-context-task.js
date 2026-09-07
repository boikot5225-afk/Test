'use strict';

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

function target(raw, index) {
  const surface = clean(raw?.surface || raw?.word, 48);
  if (!surface || !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/u.test(surface)) return null;
  const senses = Array.isArray(raw?.senses)
    ? raw.senses.map(safeRu).filter(Boolean).slice(0, 8)
    : [];
  return {
    id: clean(raw?.id || `t${index}`, 40) || `t${index}`,
    surface,
    lemma: clean(raw?.lemma, 48),
    localRu: safeRu(raw?.localRu),
    senses,
  };
}

function buildEsContextBatchPrompt(body = {}) {
  const context = clean(body.context, MAX_CONTEXT_CHARS);
  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .slice(0, MAX_TARGETS)
    .map(target)
    .filter(Boolean);
  if (!context || !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/u.test(context)) {
    throw new Error('Нужен испанский context.');
  }
  if (!targets.length) throw new Error('Нет Spanish Unknown targets.');
  const ids = new Set();
  for (const item of targets) {
    if (ids.has(item.id)) throw new Error('Повторяющийся target id.');
    ids.add(item.id);
  }

  return `You are the contextual Spanish->Russian inline-gloss engine for a book reader.

You receive ONE exact Spanish paragraph and token OCCURRENCES currently marked Unknown. The reader has ALREADY shown an offline WikDict gloss. Your job is to replace it only when the exact paragraph makes a different meaning genuinely clear.

For every target return:
- id: copy exactly;
- ru: short natural Russian gloss for THIS occurrence, normally 1-4 words;
- lemma: Spanish dictionary lemma/infinitive;
- pos: noun|verb|adjective|adverb|pronoun|preposition|conjunction|proper_noun|other;
- confidence: number 0..1;
- note: optional very short Russian phrase for a fixed expression/collocation, otherwise "".

STRICT RULES:
1. Context wins over the first dictionary sense, but localRu/senses are useful offline WikDict hints. Do NOT change a plausible local gloss merely to sound different.
2. Be conservative with confidence. Use >=0.90 only when the paragraph makes the intended Russian sense genuinely clear. Ambiguity or insufficient context must stay below 0.90 so the client keeps WikDict.
3. Conjugated verbs must be resolved to the correct lemma and glossed naturally in this sentence. Reflexive/pronominal verbs and clitics matter: se quedó, me di cuenta, dímelo, ponerse, echar de menos, darse cuenta de.
4. Fixed expressions and phrasal constructions must use their actual contextual meaning, not literal component meanings.
5. Preserve lexical distinctions that Spanish spelling hides. Examples: banco can be "скамейка" or "банк"; vela can be "свеча" or "парус"; capital can be "столица" or "капитал" depending on context.
6. Real proper names are never vocabulary glosses. Set pos="proper_noun", ru="", confidence high enough to suppress replacement. Examples: Madrid, Londres, García, Cervantes.
7. Do not translate punctuation, article+name fragments, or invent meanings for a name.
8. Return one item for EVERY supplied id, with no missing or extra ids.
9. Return ONLY JSON with this exact top-level shape:
{"items":[{"id":"t0","ru":"...","lemma":"...","pos":"noun","confidence":0.95,"note":""}]}

CONTEXT:
${context}

TARGETS:
${JSON.stringify(targets)}`;
}

module.exports = { buildEsContextBatchPrompt };

'use strict';

const MAX_CONTEXT_CHARS = 1800;
const MAX_TARGETS = 24;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function shortRu(value) {
  const text = clean(value, 48)
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, '')
    .replace(/[;,.!?…]+$/g, '')
    .trim();
  if (!/[\u0400-\u052f]/u.test(text)) return '';
  return text.split(/\s+/).filter(Boolean).length <= 5 ? text : '';
}

function safeTarget(raw, index) {
  const surface = clean(raw?.surface || raw?.word, 48);
  if (!surface || !/[A-Za-z]/u.test(surface)) return null;
  return {
    id: clean(raw?.id || `t${index}`, 40) || `t${index}`,
    surface,
    lemma: clean(raw?.lemma, 48),
    localRu: shortRu(raw?.localRu),
    senses: Array.isArray(raw?.senses)
      ? raw.senses.map(shortRu).filter(Boolean).slice(0, 8)
      : [],
  };
}

function buildEnContextBatchPrompt(body = {}) {
  const context = clean(body.context, MAX_CONTEXT_CHARS);
  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .slice(0, MAX_TARGETS)
    .map(safeTarget)
    .filter(Boolean);
  if (!context || !/[A-Za-z]/u.test(context)) throw new Error('Нужен английский context.');
  if (!targets.length) throw new Error('Нет English Unknown targets.');
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error('Повторяющийся target id.');
    ids.add(target.id);
  }

  return `You are the contextual English-to-Russian inline-gloss engine for a serious book reader.

You receive ONE exact English paragraph and token OCCURRENCES currently marked Unknown. The reader has ALREADY painted an immediate offline WikDict gloss. Your job is only to replace it when the paragraph makes a better contextual meaning clear.

Return for every target:
- id: copy exactly;
- ru: natural short Russian gloss for THIS occurrence, usually 1-4 words;
- lemma: English dictionary lemma/base form;
- pos: noun|verb|adjective|adverb|pronoun|preposition|conjunction|proper_noun|other;
- confidence: calibrated 0..1;
- note: optional very short Russian name of the idiom/phrasal verb/collocation, else "".

STRICT RULES:
1. Full paragraph context wins over localRu and senses, but DO NOT change a reasonable dictionary gloss just to sound different. If the contextual sense is not clearly better, keep the same meaning and lower confidence.
2. Phrasal verbs, idioms and collocations must be interpreted as a unit. Examples: "give up" -> "сдаться/бросить" by context; "run out" -> "закончиться"; "take off" -> "взлететь/снять" by context; "get the show on the road" -> "приступить к делу".
3. Polysemy must follow this exact paragraph. "bank" can be "банк" or "берег"; "charge" can be "плата", "обвинение", "заряжать" or "атаковать"; "right" can be "право", "правый", "правильно", "сейчас" etc.
4. Prefer the Russian form that helps reading THIS sentence, not mechanically an infinitive. "He charged at them" may be "бросился"; "She was charged with fraud" may be "обвинили".
5. Preserve negation, particle meaning and argument structure when Russian needs it. Do not translate a phrasal particle as an independent dictionary word if it belongs to the verb.
6. Proper names: pos="proper_noun", ru="". Never invent a translation for a person's/place/company name.
7. ru must contain Russian Cyrillic unless pos is proper_noun. No English explanations or dictionary lists in ru.
8. Be conservative with confidence. Use >=0.90 only when the contextual sense is genuinely clear; 0.70-0.85 for plausible but not certain; below 0.70 when the offline gloss should probably remain.
9. Return one item for EVERY supplied id and no extra ids.
10. Return ONLY JSON of shape {"items":[{"id":"t0","ru":"...","lemma":"...","pos":"verb","confidence":0.95,"note":""}]}.

CONTEXT:
${context}

TARGETS:
${JSON.stringify(targets)}`;
}

module.exports = { buildEnContextBatchPrompt, MAX_CONTEXT_CHARS, MAX_TARGETS };

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
  if (!surface || !/[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]/u.test(surface)) return null;
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

function buildFrContextBatchPrompt(body = {}) {
  const context = clean(body.context, MAX_CONTEXT_CHARS);
  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .slice(0, MAX_TARGETS)
    .map(safeTarget)
    .filter(Boolean);
  if (!context || !/[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]/u.test(context)) throw new Error('Нужен французский context.');
  if (!targets.length) throw new Error('Нет French Unknown targets.');
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error('Повторяющийся target id.');
    ids.add(target.id);
  }

  return `You are the contextual French-to-Russian inline-gloss engine for a serious book reader.

You receive ONE exact French paragraph and token OCCURRENCES currently marked Unknown. Translate EACH OCCURRENCE by what it means HERE, not by its first dictionary sense.

Return for every target:
- id: copy exactly;
- ru: natural short Russian gloss for THIS occurrence, usually 1-4 words;
- lemma: French dictionary lemma/infinitive;
- pos: noun|verb|adjective|adverb|pronoun|preposition|conjunction|proper_noun|other;
- confidence: 0..1;
- note: optional very short Russian name of the idiom/collocation, else "".

STRICT RULES:
1. Full paragraph context wins over localRu and senses. They are hints only and can be wrong.
2. Prefer a Russian form that helps reading THIS sentence, not mechanically an infinitive. "Je le précise" -> "уточняю". "nous sommes contraints" -> "вынуждены".
3. Preserve clitic meaning when Russian needs it. "t'ennuiera" may be "тебе надоест" / "тебя огорчит" depending on this exact sentence; never return a loading marker or a context-free infinitive merely because the lemma is ennuyer.
4. Fixed expressions and collocations get their real meaning. "user la force" -> "применить" / "применять", NEVER "износить". "se hâter de te dire" -> contextual "спешу/тороплюсь". "le moindre" -> "малейший" when that is the construction.
5. Inflected/adjectival forms must fit the sentence: "ennuyée" should be a contextual Russian adjective/participle such as "огорчена", "расстроена", "скучающая" only as the paragraph requires.
6. Proper names: pos="proper_noun", ru="". Never invent a translation for a name.
7. ru must contain Russian Cyrillic unless pos is proper_noun. No French, English, explanations, or dictionary lists in ru.
8. Return one item for EVERY supplied id and no extra ids.
9. Return ONLY JSON of shape {"items":[{"id":"t0","ru":"...","lemma":"...","pos":"verb","confidence":0.95,"note":""}]}.

CONTEXT:
${context}

TARGETS:
${JSON.stringify(targets)}`;
}

module.exports = { buildFrContextBatchPrompt, MAX_CONTEXT_CHARS, MAX_TARGETS };

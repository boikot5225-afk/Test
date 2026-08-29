'use strict';

const MAX_CONTEXT_CHARS = 1200;
const MAX_TARGETS = 24;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
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

function buildZhContextBatchPrompt(body = {}) {
  const context = clean(body.context, MAX_CONTEXT_CHARS);
  const rawTargets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS) : [];
  const targets = rawTargets.map(safeTarget).filter(Boolean);

  if (!context || !/[\u3400-\u9fff]/.test(context)) {
    throw new Error('Нужен китайский context.');
  }
  if (!targets.length) throw new Error('Нет Unknown targets.');

  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error('Повторяющийся target id.');
    ids.add(target.id);
  }

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

module.exports = {
  buildZhContextBatchPrompt,
  MAX_CONTEXT_CHARS,
  MAX_TARGETS,
};

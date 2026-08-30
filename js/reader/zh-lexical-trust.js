// Reader AI Chinese lexical pipeline v2 — translation provenance/trust.
//
// A Cyrillic string is not proof of a good lexical translation. In particular,
// isolated ML Kit ZH→RU and CC-CEDICT-English→WikDict-Russian are useful as
// emergency fallbacks but are not authoritative enough to block contextual AI.
// This module centralises that rule so every Chinese gloss layer stops inventing
// its own notion of "done".

const CYRILLIC_RE = /[\u0400-\u052f]/;

export const ZH_GLOSS_TRUST = Object.freeze({
  missing: 0,
  machine: 0.28,
  lexical: 0.86,
  context: 0.98,
  manual: 1.0,
});

const CONTEXT_SOURCES = new Set([
  'context-ai', 'deepseek-context', 'deepseek_batch', 'context-cache', 'manual-deepseek',
]);
const MACHINE_SOURCES = new Set([
  'mlkit-zh-ru', 'mlkit-en-ru', 'en', 'wikdict-en-ru', 'offline-en-ru', 'machine',
]);
const MANUAL_SOURCES = new Set(['manual', 'user', 'user-override']);

export function cleanRussian(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return CYRILLIC_RE.test(text) ? text : '';
}

export function displayedChineseRussian(wrap) {
  if (!wrap) return '';
  const meaning = wrap.querySelector?.(':scope > .rw-zh-readable-ru .rw-zh-readable-meaning');
  const values = [
    meaning?.textContent,
    wrap.dataset?.zhGlossContextRu,
    wrap.dataset?.zhGlossStickyRu,
    wrap.dataset?.zhGlossRuReadable,
    wrap.dataset?.zhGlossRu,
  ];
  for (const value of values) {
    const ru = cleanRussian(value);
    if (ru) return ru;
  }
  return '';
}

export function lexicalRussian(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return cleanRussian(
    entry.ru || entry.russian || entry.translation_ru || entry.meaning_ru || entry.gloss_ru || '',
  );
}

export function normalizeGlossSource(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

export function classifyChineseGloss({ wrap = null, entry = null } = {}) {
  const displayed = displayedChineseRussian(wrap);
  const direct = lexicalRussian(entry);
  const source = normalizeGlossSource(wrap?.dataset?.zhGlossSource || entry?._source || '');

  if (MANUAL_SOURCES.has(source) || source.includes('manual')) {
    return { kind: 'manual', trust: ZH_GLOSS_TRUST.manual, ru: displayed || direct, source, needsContext: false };
  }
  if (CONTEXT_SOURCES.has(source) || source.includes('context-ai') || source.includes('deepseek')) {
    return { kind: 'context', trust: ZH_GLOSS_TRUST.context, ru: displayed || direct, source, needsContext: false };
  }

  // A direct Russian lexical entry is trusted even if the display layer has not
  // painted it yet. This is where future direct ZH→RU dictionaries plug in.
  if (direct && !MACHINE_SOURCES.has(source) && !source.includes('mlkit') && !source.includes('wikdict-en')) {
    return { kind: 'lexical', trust: ZH_GLOSS_TRUST.lexical, ru: direct, source, needsContext: false };
  }

  if (!displayed) {
    return { kind: 'missing', trust: ZH_GLOSS_TRUST.missing, ru: '', source, needsContext: true };
  }

  // Any Russian that came from isolated NMT or an English pivot is provisional.
  // It may stay visible while the batch is in flight, but it MUST NOT suppress
  // the contextual request. This catches 国号→"Национальный номер",
  // 称谓→"Заглавие", 违反→"изнасиловать" and the same family of errors.
  return { kind: 'machine', trust: ZH_GLOSS_TRUST.machine, ru: displayed, source, needsContext: true };
}

export function chineseGlossNeedsContext(options = {}) {
  return classifyChineseGloss(options).needsContext;
}

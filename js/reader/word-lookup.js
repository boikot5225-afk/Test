// Reader local lookup.
// This module keeps the existing lookup order intact:
// Chinese local/remote dictionary → Japanese local dictionary →
// French quick/cache/verb/noun lookup.
// DeepSeek is deliberately not called here.

export function createReaderWordLookup({
  currentLang,
  normalizeWord,
  lookupChineseWord,
  lookupJapaneseWord = null,
  fetchChineseDictEntry,
  quickLookup,
  getCachedLexical,
  findVerbByForm,
  findKnownNoun,
}) {
  function chineseOfflineResult(entry) {
    if (!entry || typeof entry !== 'object') return entry || null;
    const ru = String(entry.ru || entry.translation_ru || entry.russian || entry.meaning_ru || '').trim();
    if (ru) return entry;
    const enRaw = entry.en || entry.english || entry.definition || entry.definitions || entry.gloss || '';
    const en = Array.isArray(enRaw) ? enRaw.join('; ') : String(enRaw || '').trim();
    if (!en) return entry;
    // Reader-app historically uses "has Russian meaning" as the signal for
    // whether it should automatically call DeepSeek after a local Chinese hit.
    // With DeepSeek optional/offline-first, an English CC-CEDICT answer is a
    // complete local result too. Put the fallback in the transient `ru` field so
    // that old caller stops there; the word-panel bridge clears the editable RU
    // input immediately, so English can never be accidentally saved as Russian.
    return {
      ...entry,
      ru: `EN: ${en}`,
      _source: 'offline-cedict-en',
      _offlineEnglishFallback: true,
    };
  }

  async function lookup(word) {
    const lang = currentLang();
    const normalized = normalizeWord(word, lang);
    if (!normalized) return null;

    if (lang === 'zh') {
      const local = lookupChineseWord(normalized);
      if (local) return chineseOfflineResult(local);
      return chineseOfflineResult(await fetchChineseDictEntry(normalized));
    }

    // JMdict answers the form as it appears in the text, deinflecting it to a
    // dictionary form on the way. A miss stops here rather than falling through
    // the French quick/verb/noun tables, which can never match kana or kanji —
    // the caller already treats null as "ask DeepSeek".
    if (lang === 'ja') return lookupJapaneseWord?.(normalized) || null;

    const quick = quickLookup(normalized);
    if (quick) return quick;

    const cached = getCachedLexical(normalized);
    if (cached) return { ...cached, _source: 'cache', _note: 'из локального кэша' };

    const verbHit = findVerbByForm(normalized);
    if (verbHit) {
      return {
        pos: 'verb',
        lemma: verbHit.verb.inf,
        fr: verbHit.verb.inf,
        ru: verbHit.verb.meaning || '',
        meaning: verbHit.verb.meaning || '',
        gender: '',
        level: verbHit.verb.level || 'A2',
        _source: 'verbs',
        _note: `форма глагола: ${verbHit.tense}`,
      };
    }

    const noun = findKnownNoun(normalized);
    if (noun) {
      return {
        ...noun,
        pos: noun.pos || 'noun',
        lemma: noun.fr || normalized,
        _source: 'local',
      };
    }

    return null;
  }

  return { lookup };
}

// Reader local lookup.
// This module keeps the existing lookup order intact:
// Chinese local/remote dictionary → French quick/cache/verb/noun lookup.
// DeepSeek is deliberately not called here.

export function createReaderWordLookup({
  currentLang,
  normalizeWord,
  lookupChineseWord,
  fetchChineseDictEntry,
  quickLookup,
  getCachedLexical,
  findVerbByForm,
  findKnownNoun,
}) {
  async function lookup(word) {
    const lang = currentLang();
    const normalized = normalizeWord(word, lang);
    if (!normalized) return null;

    if (lang === 'zh') {
      const local = lookupChineseWord(normalized);
      if (local) return local;
      return await fetchChineseDictEntry(normalized);
    }

    // Japanese has no bundled dictionary yet. Stop here instead of falling
    // through the French quick/verb/noun tables — they can never match kana or
    // kanji, and the caller already treats null as "ask DeepSeek".
    if (lang === 'ja') return null;

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

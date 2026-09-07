// Reader local lookup.
// It keeps language owners isolated:
// Chinese local/remote dictionary → Japanese local dictionary →
// Spanish WordHoard/WikDict lexical owner → legacy French quick/cache/verb/noun.
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
    return {
      ...entry,
      en,
      english: entry.english || en,
      _source: entry._source || 'offline-cedict-en',
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

    if (lang === 'ja') return lookupJapaneseWord?.(normalized) || null;

    // Spanish must stop here. Before toc134 it accidentally fell through into
    // the old French quick/cache/verb/noun chain, so a Spanish tap could miss or
    // be interpreted with French morphology. The ES lexical owner consumes the
    // same WordHoard/WikDict assets as inline Spanish glosses.
    if (lang === 'es') {
      const analyze = globalThis.readerSpanishLexicalAnalysisFor;
      if (typeof analyze !== 'function') return null;
      try { return await analyze(normalized); }
      catch (error) {
        console.warn('[reader lookup] Spanish lexical analysis failed', error?.message || error);
        return null;
      }
    }

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

function canonicalLang(value) {
  const raw = String(value || 'fr').trim().toLowerCase();
  if (raw === 'zh' || raw === 'cn' || raw.startsWith('zh-')) return 'zh';
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  if (raw === 'es' || raw.startsWith('es-')) return 'es';
  if (raw === 'de' || raw.startsWith('de-')) return 'de';
  return 'fr';
}

function bookIdsFromPlaces(state) {
  return [...new Set(Object.keys(state?.places || {})
    .map(place => String(place).split(':')[0])
    .filter(Boolean))];
}

export function buildReaderWordSources(wordState, books, lang = 'fr') {
  const language = canonicalLang(lang);
  const words = Object.values(wordState || {}).filter(state =>
    state?.word && canonicalLang(state.lang || 'fr') === language);
  const byBook = new Map();

  for (const state of words) {
    for (const bookId of bookIdsFromPlaces(state)) {
      if (!byBook.has(bookId)) byBook.set(bookId, []);
      byBook.get(bookId).push(state);
    }
  }

  // Historical word states can outlive a deleted book. Only real books become
  // filters, so an internal book_* id can never leak into the interface.
  const sources = (Array.isArray(books) ? books : [])
    .filter(book => book?.id && canonicalLang(book.lang || book.sourceLang || 'fr') === language)
    .filter(book => byBook.has(book.id))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .map(book => ({
      id: book.id,
      title: String(book.title || 'Текст без названия').trim() || 'Текст без названия',
      count: byBook.get(book.id).length,
    }));

  return { words, byBook, sources };
}

export { canonicalLang as wordSourceCanonicalLang };

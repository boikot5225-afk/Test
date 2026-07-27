import { buildReaderWordSources } from '../js/reader/word-source-filters.js';

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`✓ ${name}`);
}

const states = {
  'es:herencia': {
    word: 'herencia', lang: 'es', saved: true,
    places: { 'book_spanish:ch_1:4': true },
  },
  'es:tipo': {
    word: 'tipo', lang: 'es', clicked: 2,
    places: { 'book_deleted:ch_2:8': true },
  },
  'fr:heritage': {
    word: 'héritage', lang: 'fr', saved: true,
    places: { 'book_french:ch_1:4': true },
  },
};

const books = [
  { id: 'book_spanish', title: 'El narco', lang: 'es', updatedAt: '2026-07-20T09:00:00Z' },
  { id: 'book_french', title: 'Le livre', lang: 'fr', updatedAt: '2026-07-20T10:00:00Z' },
];

const result = buildReaderWordSources(states, books, 'es');
assert('only current-language words are shown', result.words.length === 2);
assert('available source uses the human book title', result.sources.length === 1 && result.sources[0].title === 'El narco');
assert('internal book id is never used as a source title', result.sources.every(source => !source.title.startsWith('book_')));
assert('deleted-book words remain available in All', result.words.some(word => word.word === 'tipo'));
assert('deleted book does not create a raw-id filter', !result.sources.some(source => source.id === 'book_deleted'));
assert('book filter contains its words', result.byBook.get('book_spanish')?.[0]?.word === 'herencia');

console.log('reader word sources: OK');

import assert from 'node:assert/strict';
import {
  extractReaderOpenBookId,
  mergeBooksById,
} from '../js/reader/library-cover-stage1.js';

assert.equal(
  extractReaderOpenBookId("readerOpenBook('book_123')"),
  'book_123',
  'single-quoted readerOpenBook id should be extracted',
);
assert.equal(
  extractReaderOpenBookId('readerOpenBook("book_456");setTimeout(()=>readerListenToggle(),400)'),
  'book_456',
  'double-quoted id should survive extra onclick code',
);
assert.equal(extractReaderOpenBookId('readerDeleteBook("book_1")'), '', 'unrelated onclick must not match');

const merged = mergeBooksById(
  [{ id: 'old', title: 'Old' }, { id: 'same', title: 'stale', updatedAt: '2026-01-01T00:00:00Z' }],
  [{ id: 'new', title: 'New' }, { id: 'same', title: 'fresh', updatedAt: '2026-07-16T00:00:00Z' }],
);

assert.equal(merged.length, 3, 'merge must preserve books found in either store');
assert.equal(merged.find(book => book.id === 'same')?.title, 'fresh', 'newer copy must win');

console.log('library cover stage1 checks passed');

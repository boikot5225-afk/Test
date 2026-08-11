import assert from 'node:assert/strict';
import { repairBookCursorFromRenderedState as repair } from '../js/reader/navigation-position-guard.js';

function makeBook(paragraph = 0, chapter = 4) {
  return {
    id: 'book-1',
    currentChapter: chapter,
    currentParagraph: paragraph,
    chapters: Array.from({ length: 8 }, () => ({
      paragraphs: Array.from({ length: 80 }, () => 'text'),
    })),
  };
}

// Exact failure from the Android recording:
// the user has jumped to the start of chapter 5 and visibly reached paragraph 3,
// then a translation requested at the OLD paragraph 37 resolves late and writes
// currentParagraph=37. The rendered cursor must win before save/render.
{
  const book = makeBook(37, 4);
  const result = repair({
    book,
    currentBookId: 'book-1',
    renderedBookId: 'book-1',
    renderedChapter: 4,
    renderedParagraph: 3,
  });
  assert.equal(result.changed, true);
  assert.equal(book.currentParagraph, 3);
}

// Choosing chapter 5 from the TOC while already somewhere later in chapter 5
// is intentional navigation. readerGoToChapter saves before its new DOM exists,
// so the old rendered paragraph must NOT cancel the jump to paragraph 0.
{
  const book = makeBook(0, 4);
  const result = repair({
    book,
    currentBookId: 'book-1',
    renderedBookId: 'book-1',
    renderedChapter: 4,
    renderedParagraph: 37,
    explicitNavigation: true,
  });
  assert.equal(result.changed, false);
  assert.equal(book.currentParagraph, 0);
}

// A real chapter change must never trust the still-painted previous chapter.
{
  const book = makeBook(0, 4);
  const result = repair({
    book,
    currentBookId: 'book-1',
    renderedBookId: 'book-1',
    renderedChapter: 3,
    renderedParagraph: 37,
  });
  assert.equal(result.changed, false);
  assert.equal(book.currentParagraph, 0);
}

// Normal page navigation is already reflected in both model and DOM and remains
// untouched by the guard.
{
  const book = makeBook(4, 4);
  const result = repair({
    book,
    currentBookId: 'book-1',
    renderedBookId: 'book-1',
    renderedChapter: 4,
    renderedParagraph: 4,
  });
  assert.equal(result.changed, false);
  assert.equal(book.currentParagraph, 4);
}

console.log('reader navigation position regression: PASS');

// The rendered reader surface is the last user-confirmed cursor while a book is
// open. Network callbacks (translation/analysis) are allowed to enrich the book,
// but they must never resurrect the paragraph index that was current when the
// request started.
//
// Keep this helper DOM-free so the exact rollback scenario can be regression-
// tested independently of Android/WebView.
export function repairBookCursorFromRenderedState({
  book,
  currentBookId,
  renderedBookId = '',
  renderedChapter,
  renderedParagraph,
  explicitNavigation = false,
} = {}) {
  if (!book || explicitNavigation) {
    return { changed: false, reason: explicitNavigation ? 'explicit-navigation' : 'no-book' };
  }

  const currentId = String(currentBookId || '');
  const bookId = String(book.id || '');
  if (!currentId || !bookId || currentId !== bookId) {
    return { changed: false, reason: 'not-current-book' };
  }
  if (renderedBookId && String(renderedBookId) !== bookId) {
    return { changed: false, reason: 'different-rendered-book' };
  }

  const chapter = Number(renderedChapter);
  const paragraph = Number(renderedParagraph);
  const logicalChapter = Math.max(0, Number(book.currentChapter) || 0);
  if (!Number.isInteger(chapter) || chapter !== logicalChapter) {
    return { changed: false, reason: 'different-chapter' };
  }
  if (!Number.isInteger(paragraph) || paragraph < 0) {
    return { changed: false, reason: 'invalid-rendered-paragraph' };
  }

  const paragraphCount = book.chapters?.[logicalChapter]?.paragraphs?.length;
  if (Number.isFinite(paragraphCount) && paragraphCount > 0 && paragraph >= paragraphCount) {
    return { changed: false, reason: 'rendered-paragraph-out-of-range' };
  }

  const logicalParagraph = Math.max(0, Number(book.currentParagraph) || 0);
  if (logicalParagraph === paragraph) {
    return { changed: false, reason: 'already-synced' };
  }

  book.currentParagraph = paragraph;
  return {
    changed: true,
    reason: 'restored-visible-cursor',
    from: [logicalChapter, logicalParagraph],
    to: [logicalChapter, paragraph],
  };
}

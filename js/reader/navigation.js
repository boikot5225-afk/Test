import {
  contentItemText,
  firstReadableContentIndex,
  lastReadableContentIndex,
} from './semantic-content.js?v=1';

function hasReadableText(item) {
  return contentItemText(item).trim().length > 0;
}

function nearestReadableIndex(items = [], requested = 0) {
  if (!items.length) return 0;
  const start = Math.max(0, Math.min(Number(requested) || 0, items.length - 1));
  if (hasReadableText(items[start])) return start;
  const after = firstReadableContentIndex(items, start + 1);
  if (after > start && after < items.length && hasReadableText(items[after])) return after;
  return lastReadableContentIndex(items, start - 1);
}

export function createReaderNavigation(deps) {
  const { getBook, render, closeParagraphTime, scrollActiveParagraph, showToast } = deps;

  function currentParagraphText(index = null) {
    const book = getBook();
    if (!book) return '';
    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    if (index === '__chapter__') return items.map(contentItemText).filter(Boolean).join(' ');
    const idx = index == null ? (book.currentParagraph || 0) : Number(index);
    return contentItemText(items[idx]);
  }

  function selectParagraph(index) {
    const book = getBook();
    if (!book) return;
    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    book.currentParagraph = nearestReadableIndex(items, index);
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) >= (book.chapters?.length || 1) - 1) return showToast('Это последняя глава');
    book.currentChapter = (book.currentChapter || 0) + 1;
    const chapter = book.chapters[book.currentChapter];
    book.currentParagraph = firstReadableContentIndex(chapter?.paragraphs || []);
    book.updatedAt = new Date().toISOString();
    render();
  }

  function previousChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) <= 0) return showToast('Это первая глава');
    book.currentChapter = (book.currentChapter || 0) - 1;
    const chapter = book.chapters[book.currentChapter];
    book.currentParagraph = firstReadableContentIndex(chapter?.paragraphs || []);
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextParagraph() {
    const book = getBook();
    if (!book) return;
    closeParagraphTime();

    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    const next = firstReadableContentIndex(items, (book.currentParagraph || 0) + 1);

    if (next < items.length && hasReadableText(items[next])) {
      book.currentParagraph = next;
    } else if ((book.currentChapter || 0) < (book.chapters?.length || 1) - 1) {
      book.currentChapter = (book.currentChapter || 0) + 1;
      const newChapter = book.chapters[book.currentChapter];
      book.currentParagraph = firstReadableContentIndex(newChapter?.paragraphs || []);
    } else {
      return showToast('Это конец текста');
    }

    book.updatedAt = new Date().toISOString();
    render();
    scrollActiveParagraph();
  }

  function previousParagraph() {
    const book = getBook();
    if (!book) return;
    closeParagraphTime();

    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    const previous = lastReadableContentIndex(items, (book.currentParagraph || 0) - 1);

    if (previous >= 0 && previous < (book.currentParagraph || 0) && hasReadableText(items[previous])) {
      book.currentParagraph = previous;
    } else if ((book.currentChapter || 0) > 0) {
      book.currentChapter = (book.currentChapter || 0) - 1;
      const previousChapter = book.chapters[book.currentChapter];
      book.currentParagraph = lastReadableContentIndex(previousChapter?.paragraphs || []);
    } else {
      return showToast('Это начало текста');
    }

    book.updatedAt = new Date().toISOString();
    render();
    scrollActiveParagraph();
  }

  return {
    currentParagraphText,
    selectParagraph,
    nextChapter,
    previousChapter,
    nextParagraph,
    previousParagraph,
  };
}

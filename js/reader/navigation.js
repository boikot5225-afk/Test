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

function bumpNavigationEpoch() {
  globalThis.__readerNavigationEpoch = Number(globalThis.__readerNavigationEpoch || 0) + 1;
  return globalThis.__readerNavigationEpoch;
}

function withExplicitChapterNavigation(work) {
  globalThis.__readerExplicitNavigationDepth = Number(globalThis.__readerExplicitNavigationDepth || 0) + 1;
  bumpNavigationEpoch();
  try { return work(); }
  finally {
    globalThis.__readerExplicitNavigationDepth = Math.max(0, Number(globalThis.__readerExplicitNavigationDepth || 0) - 1);
  }
}

export function createReaderNavigation(deps) {
  const { getBook, render, closeParagraphTime, scrollActiveParagraph, showToast } = deps;

  function currentParagraphText(index = null) {
    const book = getBook();
    if (!book) return '';
    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    if (typeof index === 'string' && index.startsWith('__chapter')) {
      return items.map(contentItemText).filter(Boolean).join(' ');
    }
    const idx = index == null ? (book.currentParagraph || 0) : Number(index);
    return contentItemText(items[idx]);
  }

  function selectParagraph(index) {
    const book = getBook();
    if (!book) return;
    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    bumpNavigationEpoch();
    book.currentParagraph = nearestReadableIndex(items, index);
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) >= (book.chapters?.length || 1) - 1) return showToast('Это последняя глава');
    return withExplicitChapterNavigation(() => {
      book.currentChapter = (book.currentChapter || 0) + 1;
      const chapter = book.chapters[book.currentChapter];
      book.currentParagraph = firstReadableContentIndex(chapter?.paragraphs || []);
      book.updatedAt = new Date().toISOString();
      render();
    });
  }

  function previousChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) <= 0) return showToast('Это первая глава');
    return withExplicitChapterNavigation(() => {
      book.currentChapter = (book.currentChapter || 0) - 1;
      const chapter = book.chapters[book.currentChapter];
      book.currentParagraph = firstReadableContentIndex(chapter?.paragraphs || []);
      book.updatedAt = new Date().toISOString();
      render();
    });
  }

  function nextParagraph() {
    const book = getBook();
    if (!book) return;
    closeParagraphTime();

    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    const next = firstReadableContentIndex(items, (book.currentParagraph || 0) + 1);

    if (next < items.length && hasReadableText(items[next])) {
      bumpNavigationEpoch();
      book.currentParagraph = next;
      book.updatedAt = new Date().toISOString();
      render();
      scrollActiveParagraph();
      return;
    }
    if ((book.currentChapter || 0) < (book.chapters?.length || 1) - 1) {
      return withExplicitChapterNavigation(() => {
        book.currentChapter = (book.currentChapter || 0) + 1;
        const newChapter = book.chapters[book.currentChapter];
        book.currentParagraph = firstReadableContentIndex(newChapter?.paragraphs || []);
        book.updatedAt = new Date().toISOString();
        render();
        scrollActiveParagraph();
      });
    }
    return showToast('Это конец текста');
  }

  function previousParagraph() {
    const book = getBook();
    if (!book) return;
    closeParagraphTime();

    const chapter = book.chapters?.[book.currentChapter || 0];
    const items = chapter?.paragraphs || [];
    const previous = lastReadableContentIndex(items, (book.currentParagraph || 0) - 1);

    if (previous >= 0 && previous < (book.currentParagraph || 0) && hasReadableText(items[previous])) {
      bumpNavigationEpoch();
      book.currentParagraph = previous;
      book.updatedAt = new Date().toISOString();
      render();
      scrollActiveParagraph();
      return;
    }
    if ((book.currentChapter || 0) > 0) {
      return withExplicitChapterNavigation(() => {
        book.currentChapter = (book.currentChapter || 0) - 1;
        const previousChapter = book.chapters[book.currentChapter];
        book.currentParagraph = lastReadableContentIndex(previousChapter?.paragraphs || []);
        book.updatedAt = new Date().toISOString();
        render();
        scrollActiveParagraph();
      });
    }
    return showToast('Это начало текста');
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
function isImageItem(p) {
  return p != null && typeof p === 'object' && p.type === 'image';
}

function firstTextIndex(paragraphs, from = 0) {
  for (let i = from; i < paragraphs.length; i++) {
    if (!isImageItem(paragraphs[i])) return i;
  }
  return from;
}

function lastTextIndex(paragraphs, from) {
  const start = from ?? paragraphs.length - 1;
  for (let i = start; i >= 0; i--) {
    if (!isImageItem(paragraphs[i])) return i;
  }
  return 0;
}

export function createReaderNavigation(deps) {
  const { getBook, render, closeParagraphTime, scrollActiveParagraph, showToast } = deps;

  function currentParagraphText(index = null) {
    const book = getBook();
    if (!book) return '';
    const chapter = book.chapters?.[book.currentChapter || 0];
    const idx = index == null ? (book.currentParagraph || 0) : index;
    const p = chapter?.paragraphs?.[idx];
    return isImageItem(p) ? '' : (p || '');
  }

  function selectParagraph(index) {
    const book = getBook();
    if (!book) return;
    const chapter = book.chapters?.[book.currentChapter || 0];
    const paragraphs = chapter?.paragraphs || [];
    const target = isImageItem(paragraphs[index])
      ? firstTextIndex(paragraphs, index + 1)
      : index;
    book.currentParagraph = target;
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) >= (book.chapters?.length || 1) - 1) return showToast('Это последняя глава');
    book.currentChapter = (book.currentChapter || 0) + 1;
    const ch = book.chapters[book.currentChapter];
    book.currentParagraph = firstTextIndex(ch?.paragraphs || []);
    book.updatedAt = new Date().toISOString();
    render();
  }

  function previousChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) <= 0) return showToast('Это первая глава');
    book.currentChapter = (book.currentChapter || 0) - 1;
    const ch = book.chapters[book.currentChapter];
    book.currentParagraph = firstTextIndex(ch?.paragraphs || []);
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextParagraph() {
    const book = getBook();
    if (!book) return;
    closeParagraphTime();
    const chapter = book.chapters?.[book.currentChapter || 0];
    const paragraphs = chapter?.paragraphs || [];
    const max = (paragraphs.length || 1) - 1;
    let next = (book.currentParagraph || 0) + 1;
    while (next <= max && isImageItem(paragraphs[next])) next++;

    if (next <= max) {
      book.currentParagraph = next;
    } else if ((book.currentChapter || 0) < (book.chapters?.length || 1) - 1) {
      book.currentChapter = (book.currentChapter || 0) + 1;
      const newCh = book.chapters[book.currentChapter];
      book.currentParagraph = firstTextIndex(newCh?.paragraphs || []);
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
    const paragraphs = chapter?.paragraphs || [];
    let prev = (book.currentParagraph || 0) - 1;
    while (prev >= 0 && isImageItem(paragraphs[prev])) prev--;

    if (prev >= 0) {
      book.currentParagraph = prev;
    } else if ((book.currentChapter || 0) > 0) {
      book.currentChapter = (book.currentChapter || 0) - 1;
      const prevCh = book.chapters[book.currentChapter];
      book.currentParagraph = lastTextIndex(prevCh?.paragraphs || []);
    } else {
      return showToast('Это начало текста');
    }
    book.updatedAt = new Date().toISOString();
    render();
    scrollActiveParagraph();
  }

  return { currentParagraphText, selectParagraph, nextChapter, previousChapter, nextParagraph, previousParagraph };
}

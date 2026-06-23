export function createReaderNavigation(deps) {
  const { getBook, render, closeParagraphTime, scrollActiveParagraph, showToast } = deps;

  function currentParagraphText(index = null) {
    const book = getBook();
    if (!book) return '';
    const chapter = book.chapters?.[book.currentChapter || 0];
    const paragraph = index == null ? (book.currentParagraph || 0) : index;
    return chapter?.paragraphs?.[paragraph] || '';
  }

  function selectParagraph(index) {
    const book = getBook();
    if (!book) return;
    book.currentParagraph = index;
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) >= (book.chapters?.length || 1) - 1) return showToast('Это последняя глава');
    book.currentChapter = (book.currentChapter || 0) + 1;
    book.currentParagraph = 0;
    book.updatedAt = new Date().toISOString();
    render();
  }

  function previousChapter() {
    const book = getBook();
    if (!book) return;
    if ((book.currentChapter || 0) <= 0) return showToast('Это первая глава');
    book.currentChapter = (book.currentChapter || 0) - 1;
    book.currentParagraph = 0;
    book.updatedAt = new Date().toISOString();
    render();
  }

  function nextParagraph() {
    const book = getBook();
    if (!book) return;
    closeParagraphTime();
    const chapter = book.chapters?.[book.currentChapter || 0];
    const max = (chapter?.paragraphs?.length || 1) - 1;
    if ((book.currentParagraph || 0) < max) {
      book.currentParagraph = (book.currentParagraph || 0) + 1;
    } else if ((book.currentChapter || 0) < (book.chapters?.length || 1) - 1) {
      book.currentChapter = (book.currentChapter || 0) + 1;
      book.currentParagraph = 0;
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
    if ((book.currentParagraph || 0) > 0) {
      book.currentParagraph = (book.currentParagraph || 0) - 1;
    } else if ((book.currentChapter || 0) > 0) {
      book.currentChapter = (book.currentChapter || 0) - 1;
      const chapter = book.chapters?.[book.currentChapter || 0];
      book.currentParagraph = Math.max(0, (chapter?.paragraphs?.length || 1) - 1);
    } else {
      return showToast('Это начало текста');
    }
    book.updatedAt = new Date().toISOString();
    render();
    scrollActiveParagraph();
  }

  return { currentParagraphText, selectParagraph, nextChapter, previousChapter, nextParagraph, previousParagraph };
}

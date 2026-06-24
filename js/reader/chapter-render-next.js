import { bindReaderInteractions } from './interactions-runtime.js?v=1';

export function createReaderChapterRenderer({
  getCurrentBook,
  getBookLang,
  canonicalLang,
  ensureZhCoreLoaded,
  needsZhCoreLoad,
  trackParagraphSeen,
  getBookProgress,
  langBadge,
  getTranslationsHidden,
  updatePinyinButton,
  renderSongSection,
  bindSongStropheEvents,
  renderParagraphText,
  renderTranslationBlock,
  renderAnalysisBlock,
  bindVisibleParagraphTracking,
  saveBooks,
  schedulePrefetch,
  openParagraphTimer,
}) {
  function render() {
    const book = getCurrentBook();
    if (!book) return;

    const activeReaderLang = getBookLang(book);
    if (canonicalLang(activeReaderLang) === 'zh' && needsZhCoreLoad()) ensureZhCoreLoaded({ rerender: true });

    const readingView = document.getElementById('reader-reading-view');
    if (readingView) readingView.dataset.readerLang = activeReaderLang;

    const chapters = book.chapters || [];
    const chapterIndex = Math.max(0, Math.min(book.currentChapter || 0, chapters.length - 1));
    book.currentChapter = chapterIndex;
    const chapter = chapters[chapterIndex];
    const paragraphs = chapter?.paragraphs || [];
    const paragraphIndex = Math.max(0, Math.min(book.currentParagraph || 0, Math.max(0, paragraphs.length - 1)));
    book.currentParagraph = paragraphIndex;

    trackParagraphSeen(paragraphIndex, { refresh: false });
    const progress = getBookProgress(book);
    const title = document.getElementById('reader-book-title');
    const chapterTitle = document.getElementById('reader-chapter-title');
    const progressBar = document.getElementById('reader-progress-bar');
    const progressText = document.getElementById('reader-progress-text');
    const chapterText = document.getElementById('reader-chapter-text');

    if (title) title.textContent = book.title || 'Текст';
    if (chapterTitle) {
      if (book.format === 'news') {
        const source = book.newsSource || '';
        const date = book.newsDate ? new Date(book.newsDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
        chapterTitle.textContent = (source ? '📰 ' + source : '📰') + (date ? ' · ' + date : '') + ` · абзац ${paragraphIndex + 1}/${Math.max(1, paragraphs.length)}`;
      } else {
        chapterTitle.textContent = `${langBadge(activeReaderLang)} · ${chapter?.title || 'Глава'} · гл. ${chapterIndex + 1}/${chapters.length} · абзац ${paragraphIndex + 1}/${Math.max(1, paragraphs.length)}`;
      }
    }

    if (progressBar) progressBar.style.width = progress + '%';
    if (progressText) progressText.textContent = `${progress}% · абзац ${paragraphIndex + 1} / ${Math.max(1, paragraphs.length)}`;

    const comprehension = book.comprehension?.[chapter?.id];
    const note = document.getElementById('reader-comprehension-note');
    if (note) note.textContent = comprehension ? `Оценка понятности: ${comprehension}/5` : 'Оцени после чтения: это поможет выбирать уровень дальше.';

    const helpButton = document.getElementById('reader-help-btn');
    if (helpButton) helpButton.classList.toggle('on', !getTranslationsHidden());
    updatePinyinButton(activeReaderLang);

    if (chapterText) {
      chapterText.dataset.lang = activeReaderLang;
      const scroller = document.querySelector('#reader-reading-view .rd-scroll');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      const translations = book.readerTranslations || {};

      if (book.format === 'song' && chapter?.songSection) {
        chapterText.innerHTML = renderSongSection(book, chapter, paragraphs, paragraphIndex);
        bindReaderInteractions();
        bindSongStropheEvents(book, chapter);
      } else {
        chapterText.innerHTML = paragraphs.map((paragraph, index) => {
          const translationKey = `${chapter?.id}:${index}`;
          const translation = translations[translationKey];
          return `<div class="reader-paragraph ${index === paragraphIndex ? 'active' : ''}" data-p="${index}"><div class="reader-paragraph-text">${renderParagraphText(paragraph, index)}</div>${index === paragraphIndex && translation && !getTranslationsHidden() ? renderTranslationBlock(translation) : ''}${index === paragraphIndex && book.readerAnalyses?.[translationKey] && !getTranslationsHidden() ? renderAnalysisBlock(book.readerAnalyses[translationKey]) : ''}</div>`;
        }).join('');
        bindReaderInteractions();
        if (scroller) scroller.scrollTop = scrollTop;
        bindVisibleParagraphTracking(scroller);
      }
    }

    saveBooks();
    schedulePrefetch();
    openParagraphTimer();
  }

  return { render };
}

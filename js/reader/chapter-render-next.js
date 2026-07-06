import { bindReaderInteractions } from './interactions-runtime.js?v=1';

export function createReaderChapterRenderer({
  getCurrentBook,
  getBookLang,
  canonicalLang,
  ensureZhCoreLoaded,
  needsZhCoreLoad,
  isZhCoreLoaded,
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
  loadEpubImages,
}) {
  // ── Fast navigation helpers ──────────────────────────────────────
  // Returns true if we successfully updated only active-paragraph state
  // without rebuilding all DOM. Falls back to false → full render.
  function tryFastNav(chapterText, chapterIndex, paragraphs, paragraphIndex, chapter, translations, book) {
    const prevChIdx   = Number(chapterText.dataset.renderedChapter  ?? -1);
    const prevParCount = Number(chapterText.dataset.renderedParCount ?? 0);
    // If zh-core JSON loaded after the initial render, tokenisation changes
    // (individual chars → multi-char words) — must do a full rebuild.
    const prevZhCore  = chapterText.dataset.renderedZhCore;
    const curZhCore   = String(!!(isZhCoreLoaded?.()));

    // Fast path is only valid when DOM matches current chapter/state exactly.
    // Translation visibility deliberately does NOT invalidate it: help blocks
    // are always rendered into the DOM and shown/hidden by the
    // body.reader-hide-translation CSS class alone — that's what lets the 👁
    // toggle be instant instead of freezing on a full chapter rebuild.
    if (
      prevChIdx !== chapterIndex ||
      prevParCount !== paragraphs.length ||
      prevZhCore !== curZhCore ||
      book.format === 'song'
    ) return false;

    const prevActive = Number(chapterText.dataset.activeParagraph ?? -1);
    if (prevActive === paragraphIndex) return true; // nothing to do

    // Deactivate old paragraph
    const oldEl = chapterText.querySelector(`.reader-paragraph[data-p="${prevActive}"]`);
    if (oldEl) {
      oldEl.classList.remove('active');
      oldEl.querySelector('.reader-translation-block')?.remove();
      oldEl.querySelector('.reader-sentence-analysis')?.remove(); // ra2/grammar-mini analysis top-level class
    }

    // Activate new paragraph
    const newEl = chapterText.querySelector(`.reader-paragraph[data-p="${paragraphIndex}"]`);
    if (!newEl) return false; // DOM mismatch — fall back to full render

    newEl.classList.add('active');
    {
      const translationKey = `${chapter?.id}:${paragraphIndex}`;
      const translation = translations[translationKey];
      const textDiv = newEl.querySelector('.reader-paragraph-text');
      if (textDiv) {
        if (translation) textDiv.insertAdjacentHTML('afterend', renderTranslationBlock(translation));
        if (book.readerAnalyses?.[translationKey]) textDiv.insertAdjacentHTML('afterend', renderAnalysisBlock(book.readerAnalyses[translationKey]));
      }
    }

    chapterText.dataset.activeParagraph = String(paragraphIndex);
    return true;
  }

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
    // Mirror into the always-on-top line that stays visible when the reader
    // chrome auto-hides (calm-reader mode).
    const freeProg = document.getElementById('rd-free-prog-fill');
    if (freeProg) freeProg.style.width = progress + '%';
    if (progressText) progressText.textContent = `${progress}% · абзац ${paragraphIndex + 1} / ${Math.max(1, paragraphs.length)}`;

    const comprehension = book.comprehension?.[chapter?.id];
    const note = document.getElementById('reader-comprehension-note');
    if (note) note.textContent = comprehension ? `Оценка понятности: ${comprehension}/5` : 'Оцени после чтения: это поможет выбирать уровень дальше.';

    const helpButton = document.getElementById('reader-help-btn');
    if (helpButton) helpButton.classList.toggle('on', !getTranslationsHidden());
    updatePinyinButton(activeReaderLang);

    if (chapterText) {
      chapterText.dataset.lang = activeReaderLang;
      const translations = book.readerTranslations || {};

      if (book.format === 'song' && chapter?.songSection) {
        chapterText.innerHTML = renderSongSection(book, chapter, paragraphs, paragraphIndex);
        chapterText.dataset.renderedChapter = String(chapterIndex);
        chapterText.dataset.renderedParCount = String(paragraphs.length);
        chapterText.dataset.renderedHidden = String(getTranslationsHidden());
        chapterText.dataset.renderedZhCore = String(!!(isZhCoreLoaded?.()));
        chapterText.dataset.activeParagraph = String(paragraphIndex);
        bindReaderInteractions();
        bindSongStropheEvents(book, chapter);
      } else {
        // ── Fast nav path: skip full DOM rebuild when only active paragraph changed ──
        if (tryFastNav(chapterText, chapterIndex, paragraphs, paragraphIndex, chapter, translations, book)) {
          saveBooks();
          schedulePrefetch();
          openParagraphTimer();
          return;
        }

        // ── Full render ──
        const scroller = document.querySelector('#reader-reading-view .rd-scroll');
        const scrollTop = scroller ? scroller.scrollTop : 0;
        chapterText.innerHTML = paragraphs.map((paragraph, index) => {
          const translationKey = `${chapter?.id}:${index}`;
          const translation = translations[translationKey];
          return `<div class="reader-paragraph ${index === paragraphIndex ? 'active' : ''}" data-p="${index}"><div class="reader-paragraph-text">${renderParagraphText(paragraph, index)}</div>${index === paragraphIndex && translation ? renderTranslationBlock(translation) : ''}${index === paragraphIndex && book.readerAnalyses?.[translationKey] ? renderAnalysisBlock(book.readerAnalyses[translationKey]) : ''}</div>`;
        }).join('');

        chapterText.dataset.renderedChapter = String(chapterIndex);
        chapterText.dataset.renderedParCount = String(paragraphs.length);
        chapterText.dataset.renderedHidden = String(getTranslationsHidden());
        chapterText.dataset.renderedZhCore = String(!!(isZhCoreLoaded?.()));
        chapterText.dataset.activeParagraph = String(paragraphIndex);

        bindReaderInteractions();
        if (scroller) scroller.scrollTop = scrollTop;
        bindVisibleParagraphTracking(scroller);
        loadEpubImages?.(chapterText);
      }
    }

    saveBooks();
    schedulePrefetch();
    openParagraphTimer();
  }

  return { render };
}

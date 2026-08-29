import { bindReaderInteractions } from './interactions-runtime.js?v=4-known-collapse';

export function createReaderChapterRenderer({
  getCurrentBook,
  getBookLang,
  canonicalLang,
  ensureZhCoreLoaded,
  needsZhCoreLoad,
  isZhCoreLoaded,
  ensureJaCoreLoaded,
  needsJaCoreLoad,
  isJaCoreLoaded,
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
  syncPagesMode,
  autoTranslateActive,
}) {
  let zhCoreWarmPromise = null;
  let jaCoreWarmPromise = null;
  let zhCoreWarmFailed = false;
  let jaCoreWarmFailed = false;

  function startCjkCoreWarmupInBackground(lang) {
    const code = canonicalLang(lang);
    const isZh = code === 'zh';
    const isJa = code === 'ja';
    if (!isZh && !isJa) return;

    const loaded = isZh ? !!isZhCoreLoaded?.() : !!isJaCoreLoaded?.();
    const failed = isZh ? zhCoreWarmFailed : jaCoreWarmFailed;
    if (loaded || failed) return;

    const ensure = isZh ? ensureZhCoreLoaded : ensureJaCoreLoaded;
    if (typeof ensure !== 'function') return;
    if (isZh ? zhCoreWarmPromise : jaCoreWarmPromise) return;

    const startWarmup = () => Promise.resolve().then(() => ensure({ rerender: false }))
      .catch((error) => {
        if (isZh) zhCoreWarmFailed = true;
        else jaCoreWarmFailed = true;
        console.warn(`[reader] ${code} core warm-up failed; keeping the local fallback`, error?.message || error);
      })
      .finally(() => {
        if (isZh) zhCoreWarmPromise = null;
        else jaCoreWarmPromise = null;
        const current = getCurrentBook?.();
        if (!current) return;

        if (isZh) {
          // Keep the already-painted Chinese chapter immutable, exactly like
          // English unknown-gloss v2: late data may improve the NEXT natural
          // render, but must never replace live reading geometry. Mark this DOM
          // as an accepted snapshot so paragraph navigation does not force a
          // delayed full rerender merely because the core became available.
          const chapterText = document.getElementById('reader-chapter-text');
          if (chapterText && canonicalLang(getBookLang(current)) === 'zh') {
            chapterText.dataset.renderedZhCore = String(!!isZhCoreLoaded?.());
          }
          try { window.dispatchEvent(new CustomEvent('reader:zh-core-ready')); } catch {}
          return;
        }

        const scroller = document.querySelector('#reader-reading-view .rd-scroll');
        const savedScrollTop = scroller ? scroller.scrollTop : 0;
        requestAnimationFrame(() => {
          render();
          if (scroller) scroller.scrollTop = savedScrollTop;
        });
      });

    if (isZh) zhCoreWarmPromise = startWarmup();
    else jaCoreWarmPromise = startWarmup();
  }

  function waitForIdle() {
    return new Promise(resolve => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 180 });
      } else {
        setTimeout(resolve, 16);
      }
    });
  }

  function syncParagraphHelpBlocks(paragraphEl, chapter, paragraphIndex, translations, book) {
    if (!paragraphEl || paragraphEl.dataset.readerPending === '1') return;
    const translationKey = `${chapter?.id}:${paragraphIndex}`;
    const translation = translations[translationKey];
    const textDiv = paragraphEl.querySelector('.reader-paragraph-text');
    if (!textDiv) return;
    if (translation && !paragraphEl.querySelector('.reader-translation-block')) {
      textDiv.insertAdjacentHTML('afterend', renderTranslationBlock(translation));
    }
    if (book.readerAnalyses?.[translationKey] && !paragraphEl.querySelector('.reader-sentence-analysis')) {
      textDiv.insertAdjacentHTML('afterend', renderAnalysisBlock(book.readerAnalyses[translationKey]));
    }
  }

  function tryFastNav(chapterText, chapterIndex, paragraphs, paragraphIndex, chapter, translations, book) {
    const prevChIdx = Number(chapterText.dataset.renderedChapter ?? -1);
    const prevParCount = Number(chapterText.dataset.renderedParCount ?? 0);
    const prevZhCore = chapterText.dataset.renderedZhCore;
    const curZhCore = String(!!(isZhCoreLoaded?.()));
    const prevJaCore = chapterText.dataset.renderedJaCore;
    const curJaCore = String(!!(isJaCoreLoaded?.()));

    if (
      prevChIdx !== chapterIndex ||
      prevParCount !== paragraphs.length ||
      prevZhCore !== curZhCore ||
      prevJaCore !== curJaCore ||
      book.format === 'song'
    ) return false;

    const prevActive = Number(chapterText.dataset.activeParagraph ?? -1);
    if (prevActive === paragraphIndex) {
      const activeEl = chapterText.querySelector(`.reader-paragraph[data-p="${paragraphIndex}"]`);
      syncParagraphHelpBlocks(activeEl, chapter, paragraphIndex, translations, book);
      return true;
    }

    const oldEl = chapterText.querySelector(`.reader-paragraph[data-p="${prevActive}"]`);
    const newEl = chapterText.querySelector(`.reader-paragraph[data-p="${paragraphIndex}"]`);
    if (!newEl || newEl.dataset.readerPending === '1') return false;

    if (oldEl) oldEl.classList.remove('active');
    newEl.classList.add('active');
    syncParagraphHelpBlocks(newEl, chapter, paragraphIndex, translations, book);

    chapterText.dataset.activeParagraph = String(paragraphIndex);
    return true;
  }

  function render() {
    const book = getCurrentBook();
    if (!book) return;

    const activeReaderLang = getBookLang(book);

    const readingView = document.getElementById('reader-reading-view');
    if (readingView) {
      readingView.dataset.readerLang = activeReaderLang;
      readingView.lang = activeReaderLang;
      readingView.dataset.readerScript = ['zh', 'ja'].includes(canonicalLang(activeReaderLang)) ? 'cjk' : 'latin';
    }

    startCjkCoreWarmupInBackground(activeReaderLang);

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
      delete chapterText.dataset.readerCoreWarmup;
      chapterText.dataset.lang = activeReaderLang;
      chapterText.lang = activeReaderLang;
      const translations = book.readerTranslations || {};

      if (book.format === 'song' && chapter?.songSection) {
        chapterText.innerHTML = renderSongSection(book, chapter, paragraphs, paragraphIndex);
        chapterText.dataset.renderedChapter = String(chapterIndex);
        chapterText.dataset.renderedParCount = String(paragraphs.length);
        chapterText.dataset.renderedHidden = String(getTranslationsHidden());
        chapterText.dataset.renderedZhCore = String(!!(isZhCoreLoaded?.()));
        chapterText.dataset.renderedJaCore = String(!!(isJaCoreLoaded?.()));
        chapterText.dataset.activeParagraph = String(paragraphIndex);
        bindReaderInteractions();
        bindSongStropheEvents(book, chapter);
      } else {
        if (tryFastNav(chapterText, chapterIndex, paragraphs, paragraphIndex, chapter, translations, book)) {
          saveBooks();
          schedulePrefetch();
          openParagraphTimer();
          syncPagesMode?.({ full: false });
          autoTranslateActive?.(paragraphIndex);
          return;
        }

        const scroller = document.querySelector('#reader-reading-view .rd-scroll');
        const scrollTop = scroller ? scroller.scrollTop : 0;

        const paragraphInnerHtml = (paragraph, index) => {
          const translationKey = `${chapter?.id}:${index}`;
          const translation = translations[translationKey];
          return `<div class="reader-paragraph-text">${renderParagraphText(paragraph, index)}</div>${translation ? renderTranslationBlock(translation) : ''}${book.readerAnalyses?.[translationKey] ? renderAnalysisBlock(book.readerAnalyses[translationKey]) : ''}`;
        };
        const paragraphHtml = (paragraph, index) => `<div class="reader-paragraph ${index === paragraphIndex ? 'active' : ''}" data-p="${index}">${paragraphInnerHtml(paragraph, index)}</div>`;

        const finalizeChapterDom = () => {
          chapterText.dataset.renderedChapter = String(chapterIndex);
          chapterText.dataset.renderedParCount = String(paragraphs.length);
          chapterText.dataset.renderedHidden = String(getTranslationsHidden());
          chapterText.dataset.renderedZhCore = String(!!(isZhCoreLoaded?.()));
          chapterText.dataset.renderedJaCore = String(!!(isJaCoreLoaded?.()));
          chapterText.dataset.activeParagraph = String(paragraphIndex);
          bindReaderInteractions();
        };

        const PRIORITY_WINDOW = 8;
        const isCjk = ['zh', 'ja'].includes(canonicalLang(activeReaderLang));
        const CHUNK_SIZE = isCjk ? 2 : 6;
        // Page mode must never expose the lazy empty paragraph shells. They were
        // previously turned into temporary one-paragraph pages, then regrouped
        // after idle back-fill; on Android that produced giant blank pages and a
        // second pagination rebuild racing the page-turn animation. In pages
        // mode materialize the chapter DOM before the one real measurement.
        // Scroll mode keeps the old lazy first-paint optimization unchanged.
        const pagesActive = syncPagesMode?.({ queryOnly: true }) === true;
        const useLazyShells = !pagesActive && paragraphs.length > PRIORITY_WINDOW * 2;
        if (!useLazyShells) {
          chapterText.innerHTML = paragraphs.map(paragraphHtml).join('');
          finalizeChapterDom();
        } else {
          const lo = Math.max(0, paragraphIndex - PRIORITY_WINDOW);
          const hi = Math.min(paragraphs.length, paragraphIndex + PRIORITY_WINDOW);
          const shellHtml = (index) => `<div class="reader-paragraph${index === paragraphIndex ? ' active' : ''}" data-p="${index}" data-reader-pending="1"></div>`;
          chapterText.innerHTML = paragraphs.map((p, index) => (index >= lo && index < hi) ? paragraphHtml(p, index) : shellHtml(index)).join('');
          finalizeChapterDom();

          const renderToken = Symbol('renderToken');
          chapterText._readerFillToken = renderToken;
          const stale = () => chapterText._readerFillToken !== renderToken || !chapterText.isConnected;
          (async () => {
            const pending = [];
            for (let i = hi; i < paragraphs.length; i++) pending.push(i);
            for (let i = lo - 1; i >= 0; i--) pending.push(i);

            for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
              await waitForIdle();
              if (stale()) return;
              // If the user switches from scroll to pages while idle back-fill
              // is still running, abort the shell path immediately and rerender
              // through the page-mode branch above. Do not let temporary pages
              // live long enough to be turned or later repaginate in place.
              if (syncPagesMode?.({ queryOnly: true }) === true) {
                requestAnimationFrame(() => { if (!stale()) render(); });
                return;
              }
              for (const index of pending.slice(i, i + CHUNK_SIZE)) {
                if (stale()) return;
                const shell = chapterText.querySelector(`.reader-paragraph[data-p="${index}"][data-reader-pending="1"]`);
                if (!shell) continue;
                shell.innerHTML = paragraphInnerHtml(paragraphs[index], index);
                shell.removeAttribute('data-reader-pending');
                const currentActive = Number(chapterText.dataset.activeParagraph);
                shell.classList.toggle('active', index === currentActive);
              }
            }
          })();
        }

        if (scroller) scroller.scrollTop = scrollTop;
        bindVisibleParagraphTracking(scroller);
        loadEpubImages?.(chapterText);
      }
    }

    saveBooks();
    schedulePrefetch();
    openParagraphTimer();
    syncPagesMode?.({ full: true });
    autoTranslateActive?.(paragraphIndex);
  }

  return { render };
}

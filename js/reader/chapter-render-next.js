import { bindReaderInteractions } from './interactions-runtime.js?v=1';

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

  // Used to hold the whole chapter paint until the dictionary arrived — a
  // blocking "Подготавливаю слова и пиньинь…" screen with nothing else on
  // it. Whatever the exact reason (network condition, a WebView quirk,
  // sheer parse/build time on slower hardware), that wait was observed on
  // a real device to not resolve, ever: the book never opened. There is no
  // load time short enough to safely gate the FIRST paint on — so don't.
  // Never block: kick the dictionary load off in the background if it
  // isn't already running, and let the caller render immediately with
  // whatever's available (the small bundled lexicon covers common words;
  // readerSegmentChineseLocal's fallback still segments the rest). When the
  // full dictionary lands, re-render in place — tryFastNav already bails to
  // a full rebuild on its own when isZhCoreLoaded()/isJaCoreLoaded() flips,
  // so existing paragraphs pick up full pinyin/furigana coverage without
  // the reader ever having stared at a blank screen for it.
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
    // Same for the Japanese dictionary: it is what supplies furigana, so a
    // chapter rendered before it arrived has none and cannot be patched up by
    // the fast path.
    const prevJaCore  = chapterText.dataset.renderedJaCore;
    const curJaCore   = String(!!(isJaCoreLoaded?.()));

    // Fast path is only valid when DOM matches current chapter/state exactly.
    // Translation visibility deliberately does NOT invalidate it: help blocks
    // are always rendered into the DOM and shown/hidden by the
    // body.reader-hide-translation CSS class alone — that's what lets the 👁
    // toggle be instant instead of freezing on a full chapter rebuild.
    if (
      prevChIdx !== chapterIndex ||
      prevParCount !== paragraphs.length ||
      prevZhCore !== curZhCore ||
      prevJaCore !== curJaCore ||
      book.format === 'song'
    ) return false;

    const prevActive = Number(chapterText.dataset.activeParagraph ?? -1);
    if (prevActive === paragraphIndex) return true; // nothing to do

    // Translation/analysis blocks are rendered for every paragraph that HAS
    // one (not just the active paragraph — see the full-render path below),
    // so switching the active paragraph only ever needs to move the
    // highlight, never add/remove help blocks that belong to other
    // paragraphs. The active paragraph's own block is only inserted here if
    // it's missing (e.g. translated after the initial render).
    const oldEl = chapterText.querySelector(`.reader-paragraph[data-p="${prevActive}"]`);
    if (oldEl) oldEl.classList.remove('active');

    const newEl = chapterText.querySelector(`.reader-paragraph[data-p="${paragraphIndex}"]`);
    if (!newEl) return false; // DOM mismatch — fall back to full render

    newEl.classList.add('active');
    {
      const translationKey = `${chapter?.id}:${paragraphIndex}`;
      const translation = translations[translationKey];
      const textDiv = newEl.querySelector('.reader-paragraph-text');
      if (textDiv) {
        if (translation && !newEl.querySelector('.reader-translation-block')) textDiv.insertAdjacentHTML('afterend', renderTranslationBlock(translation));
        if (book.readerAnalyses?.[translationKey] && !newEl.querySelector('.reader-sentence-analysis')) textDiv.insertAdjacentHTML('afterend', renderAnalysisBlock(book.readerAnalyses[translationKey]));
      }
    }

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
      // Declaring the language matters most on Android, where the Noto CJK
      // fonts the CSS asks for by name are usually not installed and the system
      // falls back on its own. Without a lang the fallback prefers Simplified
      // Chinese shapes, so Japanese renders with the wrong forms of 今 直 骨 —
      // the exact problem the per-language font stacks were meant to avoid.
      readingView.lang = activeReaderLang;
      // Layout, line-height and the ruby scaffold are the same for every
      // space-less script, only the font differs — so the CSS keys off the
      // script and reserves data-reader-lang for the font choice.
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
        // ── Fast nav path: skip full DOM rebuild when only active paragraph changed ──
        if (tryFastNav(chapterText, chapterIndex, paragraphs, paragraphIndex, chapter, translations, book)) {
          saveBooks();
          schedulePrefetch();
          openParagraphTimer();
          syncPagesMode?.({ full: false });
          autoTranslateActive?.(paragraphIndex);
          return;
        }

        // ── Full render ──
        const scroller = document.querySelector('#reader-reading-view .rd-scroll');
        const scrollTop = scroller ? scroller.scrollTop : 0;

        const paragraphHtml = (paragraph, index) => {
          const translationKey = `${chapter?.id}:${index}`;
          const translation = translations[translationKey];
          // Every paragraph that HAS a translation/analysis shows it, not just
          // the active one — otherwise switching the active paragraph away and
          // back was the only way to "regain" a help block that was already
          // there, since it got attached/detached purely based on activeness.
          return `<div class="reader-paragraph ${index === paragraphIndex ? 'active' : ''}" data-p="${index}"><div class="reader-paragraph-text">${renderParagraphText(paragraph, index)}</div>${translation ? renderTranslationBlock(translation) : ''}${book.readerAnalyses?.[translationKey] ? renderAnalysisBlock(book.readerAnalyses[translationKey]) : ''}</div>`;
        };

        const finalizeChapterDom = () => {
          chapterText.dataset.renderedChapter = String(chapterIndex);
          chapterText.dataset.renderedParCount = String(paragraphs.length);
          chapterText.dataset.renderedHidden = String(getTranslationsHidden());
          chapterText.dataset.renderedZhCore = String(!!(isZhCoreLoaded?.()));
          chapterText.dataset.renderedJaCore = String(!!(isJaCoreLoaded?.()));
          chapterText.dataset.activeParagraph = String(paragraphIndex);
          bindReaderInteractions();
        };

        // Per-paragraph Chinese/Japanese rendering (tokenize + pinyin/furigana
        // ruby HTML per word) is real work, and a long chapter has hundreds of
        // paragraphs — building all of it into one HTML string in a single
        // synchronous pass measured at 20+ SECONDS of unbroken main-thread
        // work under a mid-tier-mobile CPU profile, which is exactly the
        // "Подготавливаю слова и пиньинь…" freeze reported on real devices
        // (opening a book calls this same "Full render" path). Render a
        // window around the active paragraph synchronously — so scroll-to-
        // active and every existing synchronous caller keeps working exactly
        // as before — and fill the rest in afterward, off the main thread's
        // single unbroken stretch, a chunk at a time.
        // Galaxy A54: keep the synchronous first paint to roughly one viewport.
        // v77.41 still rendered 40 paragraphs at the start of a chapter (up to
        // 80 in the middle) before yielding, which is enough CJK token/ruby work
        // to look like the book never opened. Render only the nearby paragraphs
        // first, then fill the rest in small cancellable chunks.
        const PRIORITY_WINDOW = 8;
        const CHUNK_SIZE = 4;
        if (paragraphs.length <= PRIORITY_WINDOW * 2) {
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
            for (let i = 0; i < lo; i++) pending.push(i);
            for (let i = hi; i < paragraphs.length; i++) pending.push(i);
            for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
              await new Promise(resolve => setTimeout(resolve, 0));
              // Bail out if the user navigated away (new chapter/book render,
              // or this exact render got superseded) while we were filling in —
              // checked before every paragraph, not just every chunk, so a
              // superseded fill can't keep doing real work (and stacking with
              // whatever superseded it) for a whole chunk after it's stale.
              if (stale()) return;
              for (const index of pending.slice(i, i + CHUNK_SIZE)) {
                if (stale()) return;
                const shell = chapterText.querySelector(`.reader-paragraph[data-p="${index}"][data-reader-pending="1"]`);
                if (!shell) continue;
                shell.outerHTML = paragraphHtml(paragraphs[index], index);
                // paragraphHtml() closed over paragraphIndex from when this
                // fill started; fast-nav (tryFastNav) moves the active
                // paragraph afterward without bumping _readerFillToken, so
                // re-sync against whichever paragraph is actually active now.
                const currentActive = Number(chapterText.dataset.activeParagraph);
                const filled = chapterText.querySelector(`.reader-paragraph[data-p="${index}"]`);
                filled?.classList.toggle('active', index === currentActive);
              }
              bindReaderInteractions();
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

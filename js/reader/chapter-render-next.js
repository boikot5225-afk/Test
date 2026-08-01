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

  // Do not paint a Chinese/Japanese chapter once without readings and then
  // rebuild the whole page when the dictionary arrives. That two-stage paint
  // was the visible "pinyin appears/disappears" jump on Android. Wait for the
  // bundled local dictionary and produce one final layout instead.
  function holdFirstCjkPaintUntilCore(lang, book) {
    const code = canonicalLang(lang);
    const isZh = code === 'zh';
    const isJa = code === 'ja';
    if (!isZh && !isJa) return false;

    const loaded = isZh ? !!isZhCoreLoaded?.() : !!isJaCoreLoaded?.();
    const failed = isZh ? zhCoreWarmFailed : jaCoreWarmFailed;
    if (loaded || failed) return false;

    const ensure = isZh ? ensureZhCoreLoaded : ensureJaCoreLoaded;
    if (typeof ensure !== 'function') return false;

    const root = document.getElementById('reader-chapter-text');
    if (root && root.dataset.readerCoreWarmup !== code) {
      root.dataset.readerCoreWarmup = code;
      root.innerHTML = `
        <div class="reader-core-warmup" role="status" aria-live="polite"
          style="min-height:42vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:28px;color:var(--text-muted);font-family:'IBM Plex Sans',sans-serif;font-size:.82rem;line-height:1.5">
          <div><span style="display:block;font-size:1.25rem;margin-bottom:8px">${isZh ? '拼' : '振'}</span>${isZh ? 'Подготавливаю слова и пиньинь…' : 'Подготавливаю слова и фуригану…'}</div>
        </div>`;
    }

    const startWarmup = () => Promise.resolve().then(() => ensure({ rerender: false }))
      .catch((error) => {
        if (isZh) zhCoreWarmFailed = true;
        else jaCoreWarmFailed = true;
        console.warn(`[reader] ${code} core warm-up failed; using fallback render`, error?.message || error);
      })
      .finally(() => {
        if (isZh) zhCoreWarmPromise = null;
        else jaCoreWarmPromise = null;
        const current = getCurrentBook?.();
        if (!current) return;
        requestAnimationFrame(() => render());
      });

    if (isZh) {
      if (!zhCoreWarmPromise) zhCoreWarmPromise = startWarmup();
    } else if (!jaCoreWarmPromise) {
      jaCoreWarmPromise = startWarmup();
    }
    return true;
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

    if (holdFirstCjkPaintUntilCore(activeReaderLang, book)) return;

    // A failed prewarm is allowed to use the old non-blocking fallback. This is
    // deliberately after the one-paint guard so a healthy local dictionary
    // never causes a second chapter layout.
    if (canonicalLang(activeReaderLang) === 'zh' && needsZhCoreLoad?.()) ensureZhCoreLoaded?.({ rerender: false });
    if (canonicalLang(activeReaderLang) === 'ja' && needsJaCoreLoad?.()) ensureJaCoreLoaded?.({ rerender: false });

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
        chapterText.innerHTML = paragraphs.map((paragraph, index) => {
          const translationKey = `${chapter?.id}:${index}`;
          const translation = translations[translationKey];
          // Every paragraph that HAS a translation/analysis shows it, not just
          // the active one — otherwise switching the active paragraph away and
          // back was the only way to "regain" a help block that was already
          // there, since it got attached/detached purely based on activeness.
          return `<div class="reader-paragraph ${index === paragraphIndex ? 'active' : ''}" data-p="${index}"><div class="reader-paragraph-text">${renderParagraphText(paragraph, index)}</div>${translation ? renderTranslationBlock(translation) : ''}${book.readerAnalyses?.[translationKey] ? renderAnalysisBlock(book.readerAnalyses[translationKey]) : ''}</div>`;
        }).join('');

        chapterText.dataset.renderedChapter = String(chapterIndex);
        chapterText.dataset.renderedParCount = String(paragraphs.length);
        chapterText.dataset.renderedHidden = String(getTranslationsHidden());
        chapterText.dataset.renderedZhCore = String(!!(isZhCoreLoaded?.()));
        chapterText.dataset.renderedJaCore = String(!!(isJaCoreLoaded?.()));
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
    syncPagesMode?.({ full: true });
    autoTranslateActive?.(paragraphIndex);
  }

  return { render };
}

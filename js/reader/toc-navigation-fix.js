// Canonical TOC navigation.
//
// toc-runtime v3 displayed the correct NCX/nav rows, but its click path mutated
// a captured book object and then reopened the book. saveReaderBooks() can
// replace the in-memory book objects during dedupe, so readerOpenBook() may
// render a fresh object whose currentChapter never received that mutation.
// The reader already has one authoritative navigation API — readerGoToChapter()
// — which updates the CURRENT library book, skips leading image-only items,
// saves, renders, and scrolls. Route TOC clicks through that API instead.

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let navigating = false;

function appModule() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleKey(value) {
  const raw = clean(value).normalize?.('NFKC') || clean(value);
  try { return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
  catch { return raw.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
}

function richestMatchingBook(app, chapterIndex) {
  const current = app.readerCurrentBook?.() || null;
  if (current && Array.isArray(current.chapters) && chapterIndex < current.chapters.length) return current;

  let books = [];
  try { books = app.loadReaderBooks?.() || []; } catch {}
  if (!Array.isArray(books) || !books.length) return current;

  const title = clean(document.getElementById('reader-book-title')?.textContent || current?.title || '');
  const wanted = titleKey(title);
  const matches = books.filter(book => {
    if (!Array.isArray(book?.chapters) || chapterIndex >= book.chapters.length) return false;
    return !wanted || titleKey(book?.title) === wanted;
  });
  if (!matches.length) return current;

  return matches.sort((a, b) => {
    const chapterDiff = (b.chapters?.length || 0) - (a.chapters?.length || 0);
    if (chapterDiff) return chapterDiff;
    const paraA = (a.chapters || []).reduce((n, ch) => n + (ch?.paragraphs?.length || 0), 0);
    const paraB = (b.chapters || []).reduce((n, ch) => n + (ch?.paragraphs?.length || 0), 0);
    return paraB - paraA;
  })[0];
}

async function navigateToChapter(chapterIndex) {
  if (navigating) return false;
  navigating = true;
  try {
    const app = await appModule();
    const ci = Number(chapterIndex);
    if (!Number.isInteger(ci) || ci < 0) return false;

    let current = app.readerCurrentBook?.() || null;
    let target = richestMatchingBook(app, ci);
    if (!target?.id) {
      window.showToast?.('⚠️ Не удалось найти главу в книге');
      return false;
    }

    // A stale duplicate can still be painted on screen after the earlier broken
    // builds. Re-anchor the reader to the richest surviving copy before asking
    // the canonical chapter navigator to move.
    if (!current || String(current.id || '') !== String(target.id || '')) {
      await app.readerOpenBook?.(target.id);
      current = app.readerCurrentBook?.() || null;
    }

    if (!current || ci >= (current.chapters?.length || 0)) {
      window.showToast?.('⚠️ Эта глава не сопоставлена с текстом');
      return false;
    }

    // toc-runtime intercepts the "Оглавление" button in capture phase, so the
    // button's inline readerCloseMoreSheet() never gets to run. Without closing
    // it here, the old More sheet stays behind the TOC and pops back into view
    // immediately after a chapter is selected (exactly what the recording shows).
    try { window.readerCloseMoreSheet?.(); } catch {}
    document.getElementById('reader-sheet-back')?.classList.remove('show');
    document.getElementById('reader-more-sheet')?.classList.remove('show');

    app.readerCloseToc?.();
    app.readerGoToChapter?.(ci);

    // readerGoToChapter is synchronous; verify the canonical current object was
    // actually moved so a future regression is visible instead of silently
    // closing the sheet and doing nothing.
    const after = app.readerCurrentBook?.();
    if (Number(after?.currentChapter) !== ci) {
      console.warn('[toc-navigation] canonical navigation did not stick', {
        requested: ci,
        actual: after?.currentChapter,
        bookId: after?.id,
      });
      window.showToast?.('⚠️ Не удалось перейти к выбранной главе');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[toc-navigation] failed', error);
    window.showToast?.(`⚠️ Переход: ${error?.message || error}`);
    return false;
  } finally {
    navigating = false;
  }
}

document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest?.('#reader-toc-list [data-toc-chapter]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  navigateToChapter(button.dataset.tocChapter);
}, true);

try { window.readerTocNavigateToChapter = navigateToChapter; } catch {}
console.info('[toc-navigation] canonical chapter routing loaded');
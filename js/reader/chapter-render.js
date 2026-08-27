import './delete-fix.js?v=1';
import './toc-registry.js?v=1';
import './toc-navigation-fix.js?v=1';
import './mobile-nav-stability.js?v=1';
import { setTocVisibleBook } from './toc-runtime.js?v=3';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=9';

// readerOpenWordPanel() in the legacy orchestrator still schedules a full
// renderReaderChapter() on the next animation frame merely to recolor other
// occurrences of the tapped word. After TOC navigation that full rebuild can
// resolve a stale library snapshot and repaint chapter 0 (the cover) under the
// word sheet. The paragraph itself is already repainted in-place before that
// callback, so suppress exactly that one redundant full render.
function installWordTapRenderGuard() {
  if (globalThis.__readerWordTapRenderGuardInstalled) return;
  globalThis.__readerWordTapRenderGuardInstalled = true;
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const word = target?.closest?.('#reader-chapter-text .reader-word');
    if (!word) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    globalThis.__readerWordTapRenderGuardUntil = now + 300;
  }, true);
}

function consumeWordTapRenderGuard() {
  const until = Number(globalThis.__readerWordTapRenderGuardUntil || 0);
  if (!until) return false;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  globalThis.__readerWordTapRenderGuardUntil = 0;
  return now <= until;
}

function renderedBookKey(book) {
  return String(book?.id || book?.importKey || book?.title || 'book');
}

// The visible chapter is the last navigation decision the user actually saw.
// Background work (translation, cloud/IDB hydration, delayed page callbacks)
// is allowed to enrich the book, but it must never move the reader to another
// chapter. Intentional chapter changes are bracketed with
// __readerExplicitNavigationDepth by TOC/navigation.js, so only an unmarked
// mismatch is treated as a stale rollback.
function repairUnexpectedChapterRollback(deps) {
  if (Number(globalThis.__readerExplicitNavigationDepth || 0) > 0) return false;
  const root = document.getElementById('reader-chapter-text');
  const book = deps.getCurrentBook?.();
  if (!root || !book) return false;

  const rootBookId = String(root.dataset.readerBookId || '');
  const currentBookId = renderedBookKey(book);
  if (!rootBookId || rootBookId !== currentBookId) return false;

  const renderedChapter = Number(root.dataset.renderedChapter);
  const stateChapter = Number(book.currentChapter || 0);
  if (!Number.isInteger(renderedChapter) || renderedChapter < 0 || renderedChapter === stateChapter) return false;

  const renderedParagraph = Number(root.dataset.activeParagraph);
  const from = [stateChapter, Number(book.currentParagraph || 0)];
  book.currentChapter = renderedChapter;
  if (Number.isInteger(renderedParagraph) && renderedParagraph >= 0) {
    book.currentParagraph = renderedParagraph;
  }
  book.updatedAt = new Date().toISOString();
  console.warn('[reader render] blocked background chapter rollback', {
    bookId: currentBookId,
    from,
    to: [book.currentChapter, book.currentParagraph],
  });
  return true;
}

installWordTapRenderGuard();

export function createReaderChapterRenderer(deps) {
  const base = createBaseRenderer(deps);
  return {
    ...base,
    render(...args) {
      if (consumeWordTapRenderGuard()) {
        // Keep the visible chapter and scroll position intact. Word colors in
        // the tapped paragraph were already updated by readerOpenWordPanel().
        try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
        console.info('[reader word tap] skipped redundant full chapter rebuild');
        return undefined;
      }

      repairUnexpectedChapterRollback(deps);

      // TOC is resolved on demand from the exact EPUB registry. Do not run a
      // background book-rewriter here: older builds could delete/reconcile the
      // id of the book that was still painted on screen, leaving the reader
      // visible but detached from its library object.
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      const result = base.render(...args);
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      return result;
    },
  };
}
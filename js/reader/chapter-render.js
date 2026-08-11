import './delete-fix.js?v=1';
import './toc-registry.js?v=1';
import './toc-navigation-fix.js?v=1';
import './mobile-nav-stability.js?v=1';
import { setTocVisibleBook } from './toc-runtime.js?v=3';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=8';

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

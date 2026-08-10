import './delete-fix.js?v=1';
import './toc-registry.js?v=1';
import './toc-navigation-fix.js?v=1';
import './mobile-nav-stability.js?v=1';
import { setTocVisibleBook } from './toc-runtime.js?v=3';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=8';

export function createReaderChapterRenderer(deps) {
  const base = createBaseRenderer(deps);
  return {
    ...base,
    render(...args) {
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

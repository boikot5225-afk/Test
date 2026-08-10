import './delete-fix.js?v=1';
import { setTocVisibleBook } from './toc-authority.js?v=1';
import './toc-direct.js?v=1';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=8';

export function createReaderChapterRenderer(deps) {
  const base = createBaseRenderer(deps);
  return {
    ...base,
    render(...args) {
      // Capture the exact object that produced the visible page. The old TOC
      // path only asked readerCurrentBook(), which can become null after an
      // async owner/storage refresh even while this book is still on screen.
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      const result = base.render(...args);
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      return result;
    },
  };
}

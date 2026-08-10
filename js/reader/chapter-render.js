import './delete-fix.js?v=1';
import { setTocVisibleBook } from './toc-runtime.js?v=1';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=8';

export function createReaderChapterRenderer(deps) {
  const base = createBaseRenderer(deps);
  return {
    ...base,
    render(...args) {
      // Store only a hint. toc-runtime resolves the fresh library object on
      // every TOC tap instead of reusing a stale pre-import book object.
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      const result = base.render(...args);
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      return result;
    },
  };
}

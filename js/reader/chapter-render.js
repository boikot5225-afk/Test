import './delete-fix.js?v=1';
import './toc-registry.js?v=1';
import './toc-reconcile.js?v=2';
import { setTocVisibleBook } from './toc-runtime.js?v=2';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=8';

export function createReaderChapterRenderer(deps) {
  const base = createBaseRenderer(deps);
  return {
    ...base,
    render(...args) {
      // Only remember which saved book is visible. The TOC runtime resolves the
      // fresh library object on every tap; it never manufactures an EPUB TOC.
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      const result = base.render(...args);
      try { setTocVisibleBook(deps.getCurrentBook?.()); } catch {}
      return result;
    },
  };
}

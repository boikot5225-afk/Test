import './delete-fix.js?v=1';
import { setTocVisibleBook } from './toc-authority.js?v=1';
import { repairBookTocFromContent } from './toc-direct.js?v=1';
import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-dialogue.js?v=8';

export function createReaderChapterRenderer(deps) {
  const base = createBaseRenderer(deps);
  return {
    ...base,
    render(...args) {
      // Capture the exact object that produced the visible page. Also repair
      // legacy EPUBs *at render time*, before the user can tap the TOC button:
      // the old importer already kept publisher heading text in paragraphs even
      // when it named the chapter "Глава N".
      const before = deps.getCurrentBook?.();
      try { setTocVisibleBook(before); } catch {}
      try {
        if (before?.source === 'epub') repairBookTocFromContent(before).catch?.(() => {});
      } catch {}
      const result = base.render(...args);
      const after = deps.getCurrentBook?.();
      try { setTocVisibleBook(after); } catch {}
      try {
        if (after?.source === 'epub') repairBookTocFromContent(after).catch?.(() => {});
      } catch {}
      return result;
    },
  };
}

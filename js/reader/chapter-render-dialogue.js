import { createReaderChapterRenderer as createStage1Renderer } from './chapter-render-stage1.js?v=5';
import { normalizeSemanticBookLineItems } from './semantic-content.js?v=2';

export function createReaderChapterRenderer(deps) {
  const getCurrentBook = () => {
    const book = deps.getCurrentBook?.();
    normalizeSemanticBookLineItems(book);
    return book;
  };

  return createStage1Renderer({
    ...deps,
    getCurrentBook,
  });
}

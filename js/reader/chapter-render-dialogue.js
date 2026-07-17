import { createReaderChapterRenderer as createStage1Renderer } from './chapter-render-stage1.js?v=5';
import {
  normalizeSemanticBookLineItems,
  normalizeSemanticBookTranslations,
  translationValueText,
} from './semantic-content.js?v=3';

export function createReaderChapterRenderer(deps) {
  const getCurrentBook = () => {
    const book = deps.getCurrentBook?.();
    normalizeSemanticBookLineItems(book);
    normalizeSemanticBookTranslations(book);
    return book;
  };

  const renderTranslationBlock = typeof deps.renderTranslationBlock === 'function'
    ? (value) => {
        const text = translationValueText(value);
        return text ? deps.renderTranslationBlock(text) : '';
      }
    : deps.renderTranslationBlock;

  return createStage1Renderer({
    ...deps,
    getCurrentBook,
    renderTranslationBlock,
  });
}

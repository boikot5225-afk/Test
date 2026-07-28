import { createReaderChapterRenderer as createStage1Renderer } from './chapter-render-stage1.js?v=10';
import {
  normalizeSemanticBookLineItems,
  normalizeSemanticBookTextChunks,
  normalizeSemanticBookTranslations,
  translationValueText,
} from './semantic-content.js?v=4';

export function createReaderChapterRenderer(deps) {
  const getCurrentBook = () => {
    const book = deps.getCurrentBook?.();
    const lineItemsChanged = normalizeSemanticBookLineItems(book);
    const textChunksChanged = normalizeSemanticBookTextChunks(book);
    normalizeSemanticBookTranslations(book, {
      reindexed: lineItemsChanged || textChunksChanged,
    });
    if (book?.readerTranslations && typeof book.readerTranslations === 'object') {
      for (const [key, value] of Object.entries(book.readerTranslations)) {
        const text = translationValueText(value);
        if (/не является строкой|предоставьте текст в виде строки/i.test(text)) {
          delete book.readerTranslations[key];
        }
      }
    }
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

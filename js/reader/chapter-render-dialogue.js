import { createReaderChapterRenderer as createStage1Renderer } from './chapter-render-stage1.js?v=8';
import {
  normalizeSemanticBookLineItems,
  normalizeSemanticBookTextChunks,
  normalizeSemanticBookTranslations,
  translationValueText,
} from './semantic-content.js?v=6';

export function createReaderChapterRenderer(deps) {
  const getCurrentBook = () => {
    const book = deps.getCurrentBook?.();
    const lineItemsChanged = normalizeSemanticBookLineItems(book);
    const textChunksChanged = normalizeSemanticBookTextChunks(book);
    normalizeSemanticBookTranslations(book, {
      reindexed: lineItemsChanged || textChunksChanged,
    });
    return book;
  };

  const renderTranslationBlock = typeof deps.renderTranslationBlock === 'function'
    ? (value) => {
        const text = translationValueText(value);
        return text ? deps.renderTranslationBlock(text) : '';
      }
    : deps.renderTranslationBlock;

  const renderer = createStage1Renderer({
    ...deps,
    getCurrentBook,
    renderTranslationBlock,
  });

  return {
    ...renderer,
    render() {
      const book = getCurrentBook();
      const chapterIndex = Math.max(0, Number(book?.currentChapter) || 0);
      const paragraphIndex = Math.max(0, Number(book?.currentParagraph) || 0);
      const chapter = book?.chapters?.[chapterIndex];
      const key = `${chapter?.id}:${paragraphIndex}`;
      const root = document.getElementById('reader-chapter-text');
      const row = root?.querySelector(`.reader-paragraph[data-p="${paragraphIndex}"]`);
      const translationMissing = !!book?.readerTranslations?.[key]
        && !row?.querySelector('.reader-translation-block');
      const analysisMissing = !!book?.readerAnalyses?.[key]
        && !row?.querySelector('.reader-sentence-analysis');

      // Translation/analysis can be saved without changing the active
      // paragraph. Invalidate the fast-navigation cache so the help block is
      // inserted and page mode is repaginated immediately.
      if (root && (translationMissing || analysisMissing)) {
        root.dataset.renderedChapter = '-1';
      }
      return renderer.render();
    },
  };
}

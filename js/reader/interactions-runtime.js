import { createReaderInteractions } from './interactions.js?v=1';

function getRoot() {
  return document.getElementById('reader-chapter-text');
}

function activeParagraphIndex() {
  const index = Number(getRoot()?.querySelector('.reader-paragraph.active')?.dataset?.p);
  return Number.isFinite(index) ? index : 0;
}

function hasNativeSelection() {
  const root = getRoot();
  const selection = window.getSelection?.();
  const text = String(selection || '').replace(/\s+/g, ' ').trim();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount || !text) return false;
  const contains = (node) => root.contains(node?.nodeType === 1 ? node : node?.parentElement);
  return contains(selection.anchorNode) || contains(selection.focusNode);
}

const readerInteractions = createReaderInteractions({
  getRoot,
  hasNativeSelection,
  scheduleSelectionUpdate: () => {},
  getCurrentBook: () => ({ currentParagraph: activeParagraphIndex() }),
  openWordPanel: (word, index) => window.readerOpenWordPanel?.(word, index),
  runAction: (event, action, index) => window.readerAction?.(event, action, index),
  selectParagraph: (index) => window.readerSelectParagraph?.(index),
  nextParagraph: () => window.readerNextParagraph?.(),
  previousParagraph: () => window.readerPrevParagraph?.(),
});

export function bindReaderInteractions() {
  return readerInteractions.bindParagraphEvents();
}

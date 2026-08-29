import './toc-upgrade.js?v=1'; // retired no-op shim; kept for old cache/CI compatibility
import './handler-bridge.js?v=1';
import './zh-resource-profiles.js?v=2'; // lazy native SQLite: Migaku/BLCU/SUBTLEX/Jieba/HSK; no layout ownership
import './zh-unknown-gloss-v4.js?v=3';
import './zh-offline-word-panel.js?v=1';
import './zh-unknown-gloss-spacing.js?v=3'; // native pinyin for every Unknown word
import './vocab-estimate.js?v=8';
import './en-vocab-estimate.js?v=1';
import './en-manual-knowledge-bridge.js?v=2';
import './en-unknown-gloss-v2.js?v=3';
import './en-unknown-gloss-full-fallback.js?v=2';
import './toc51-stability.js?v=2';
import './toolbar-scroll.js?v=1';
import './zh-readable-inline.js?v=6';
import { createReaderInteractions } from './interactions.js?v=2';

function getRoot() {
  return document.getElementById('reader-chapter-text');
}

function activeParagraphIndex() {
  const index = Number(getRoot()?.querySelector('.reader-paragraph.active')?.dataset?.p);
  return Number.isFinite(index) ? index : 0;
}

function toggleReadingChrome() {
  const view = document.getElementById('reader-reading-view');
  if (!view || view.style.display === 'none') return false;
  const hidden = view.classList.toggle('rd-chrome-hidden');
  // Bars are absolutely overlaid, so toggling them must not change the logical
  // paragraph/page. Re-measure only ancillary player heights; no render/nav.
  try { window.__rdMeasureChrome?.(); } catch {}
  try {
    window.dispatchEvent(new CustomEvent('reader:chromechange', { detail: { hidden } }));
  } catch {}
  return hidden;
}
try { window.readerToggleReadingChrome = toggleReadingChrome; } catch {}

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
  toggleChrome: toggleReadingChrome,
  nextParagraph: () => window.readerNextParagraph?.(),
  previousParagraph: () => window.readerPrevParagraph?.(),
});

export function bindReaderInteractions() {
  return readerInteractions.bindParagraphEvents();
}

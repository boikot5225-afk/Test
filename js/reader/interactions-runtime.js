import './toc-upgrade.js?v=1'; // retired no-op shim; kept for old cache/CI compatibility
import './handler-bridge.js?v=1';
import './zh-resource-profiles.js?v=2'; // lazy native SQLite: Migaku/BLCU/SUBTLEX/Jieba/HSK; no layout ownership
import './zh-unknown-gloss-v4.js?v=3';
import './zh-offline-word-panel.js?v=1';
import './zh-unknown-gloss-spacing.js?v=3'; // native pinyin for every Unknown word
import './vocab-estimate.js?v=9-manual-known';
import './en-vocab-estimate.js?v=2-manual-known';
import './en-morphology-resolver.js?v=1'; // toc101: safe morphology gaps only; no layout ownership
import './en-manual-knowledge-bridge.js?v=3-manual-known';
import './en-unknown-gloss-v2.js?v=5'; // toc105: context/DeepSeek overrides outrank WikDict
import './en-unknown-gloss-full-fallback.js?v=2';
import './en-context-gloss-v1.js?v=2'; // toc105: never overwrite DeepSeek context; text-only
import './en-context-fixes-v1.js?v=2'; // toc105: DeepSeek context has final priority; text-only
import './fr-reader-pipeline-v2.js?v=1'; // toc124: event-driven French Known/Unknown + immediate local glosses
import './fr-context-batch-v4.js?v=1'; // toc125: whole-paragraph DeepSeek via readerAI; guest-safe, never blocks first paint
import './fr-lexical-pipeline-v2.js?v=124'; // French word-card lexical owner; occurrence context stays local
import './toc51-stability.js?v=2';
import './toolbar-scroll.js?v=1';
import './zh-readable-inline.js?v=8-quality';
import './zh-context-cache-v3.js?v=1'; // one-time reset of pre-polyphone AI pinyin cache
import './zh-context-auth-wakeup.js?v=1'; // retry context AI as soon as Firebase restores a user
import './zh-context-batch.js?v=8-quality'; // toc119: context owns Russian; auth retry; fresh cache
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

function refreshFrench(reason) {
  try { window.readerFrenchRefresh?.(reason, true); } catch {}
}

function afterFrenchRenderAction(reason, fn) {
  const result = fn?.();
  setTimeout(() => refreshFrench(reason), 0);
  return result;
}

const readerInteractions = createReaderInteractions({
  getRoot,
  hasNativeSelection,
  scheduleSelectionUpdate: () => {},
  getCurrentBook: () => ({ currentParagraph: activeParagraphIndex() }),
  openWordPanel: (word, index) => window.readerOpenWordPanel?.(word, index),
  runAction: (event, action, index) => window.readerAction?.(event, action, index),
  selectParagraph: (index) => afterFrenchRenderAction('select-paragraph', () => window.readerSelectParagraph?.(index)),
  toggleChrome: toggleReadingChrome,
  nextParagraph: () => afterFrenchRenderAction('next-page', () => window.readerNextParagraph?.()),
  previousParagraph: () => afterFrenchRenderAction('previous-page', () => window.readerPrevParagraph?.()),
});

export function bindReaderInteractions() {
  return readerInteractions.bindParagraphEvents();
}

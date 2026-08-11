// DOM event bindings for the reader.
// Navigation, AI actions, TTS and word-panel behavior are injected from app.js.
//
// Performance note: this module intentionally uses delegation. The old reader
// attached one click listener to every .reader-word / paragraph / action button
// after each background render chunk. On long chapters that meant repeatedly
// scanning thousands of nodes while the DOM kept growing — effectively O(n²)
// setup work. One listener on the chapter root handles current and future nodes.

export function createReaderInteractions({
  getRoot,
  hasNativeSelection,
  scheduleSelectionUpdate,
  getCurrentBook,
  openWordPanel,
  runAction,
  selectParagraph,
  toggleChrome,
  nextParagraph,
  previousParagraph,
}) {
  let suppressClickUntil = 0;

  function bindSwipe() {
    const root = getRoot();
    if (!root || root.dataset.boundReaderSwipe === '1') return;
    root.dataset.boundReaderSwipe = '1';
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let moved = false;

    root.addEventListener('touchstart', (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = Date.now();
      moved = false;
    }, { passive: true });

    root.addEventListener('touchmove', (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) moved = true;
    }, { passive: true });

    root.addEventListener('touchend', (event) => {
      if (window.__readerRanging) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Date.now() - startedAt > 600) return;
      // Android may still synthesize a click after a drag/swipe. Do not let
      // that synthetic click toggle immersive mode immediately afterwards.
      if (moved) suppressClickUntil = Date.now() + 350;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.7) {
        suppressClickUntil = Date.now() + 450;
        if (dx < 0) nextParagraph();
        else previousParagraph();
      }
    }, { passive: true });
  }

  function stopReaderClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  }

  function bindClickDelegation() {
    const root = getRoot();
    if (!root || root.dataset.boundReaderDelegation === '1') return;
    root.dataset.boundReaderDelegation = '1';

    root.addEventListener('click', (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const wordElement = target.closest('.reader-word');
      if (wordElement && root.contains(wordElement)) {
        if (window.__readerSuppressWordTap) {
          window.__readerSuppressWordTap = false;
          stopReaderClick(event);
          return;
        }
        if (hasNativeSelection()) {
          scheduleSelectionUpdate();
          stopReaderClick(event);
          return;
        }
        stopReaderClick(event);
        const word = wordElement.dataset.word || wordElement.textContent || '';
        const index = Number(wordElement.dataset.readerIndex);
        openWordPanel(word, Number.isFinite(index) ? index : (getCurrentBook()?.currentParagraph || 0));
        return;
      }

      const button = target.closest('.reader-action-btn');
      if (button && root.contains(button)) {
        stopReaderClick(event);
        const action = button.dataset.readerAction;
        const rawIndex = button.dataset.readerIndex;
        const index = rawIndex == null || rawIndex === '' ? null : Number(rawIndex);
        runAction(event, action, Number.isFinite(index) ? index : null);
        return;
      }

      if (target.closest('.reader-action-btn, .reader-word, details, summary, button, input, textarea, select, a, audio')) return;
      const paragraph = target.closest('.reader-paragraph');
      if (!paragraph || !root.contains(paragraph)) return;

      // A normal tap on the reading surface is the reader's immersive/full-screen
      // gesture. The old handler called selectParagraph() here. In page mode that
      // changes the logical active paragraph and resyncs pagination, so a harmless
      // tap could jump to another paragraph/page instead of hiding the chrome.
      // Paragraph selection is already maintained by page navigation / visibility
      // tracking; do not mutate reading position on a plain tap.
      if (Date.now() < suppressClickUntil) {
        stopReaderClick(event);
        return;
      }
      stopReaderClick(event);
      if (typeof toggleChrome === 'function') toggleChrome();
    }, true);
  }

  function bindParagraphEvents() {
    bindSwipe();
    bindClickDelegation();
  }

  function installActionDelegation() {
    if (window.__readerActionDelegationInstalled) return;
    window.__readerActionDelegationInstalled = true;
    document.addEventListener('click', (event) => {
      const button = event.target?.closest?.('.reader-action-btn');
      if (!button || event.defaultPrevented) return;
      // Reader-chapter actions are handled by the root delegate above. Keep this
      // document-level fallback only for action buttons rendered outside it.
      const root = getRoot();
      if (root?.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      const action = button.dataset.readerAction;
      const rawIndex = button.dataset.readerIndex;
      const index = rawIndex == null || rawIndex === '' ? null : Number(rawIndex);
      runAction(null, action, Number.isFinite(index) ? index : null);
    }, true);
  }

  return { bindSwipe, bindParagraphEvents, installActionDelegation };
}
// DOM event bindings for the reader.
// Navigation, AI actions, TTS and word-panel behavior are injected from app.js.

export function createReaderInteractions({
  getRoot,
  hasNativeSelection,
  scheduleSelectionUpdate,
  getCurrentBook,
  openWordPanel,
  runAction,
  selectParagraph,
  nextParagraph,
  previousParagraph,
}) {
  function bindSwipe() {
    const root = getRoot();
    if (!root || root.dataset.boundReaderSwipe === '1') return;
    root.dataset.boundReaderSwipe = '1';
    let startX = 0;
    let startY = 0;
    let startedAt = 0;

    root.addEventListener('touchstart', (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = Date.now();
    }, { passive: true });

    root.addEventListener('touchend', (event) => {
      if (window.__readerRanging) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Date.now() - startedAt > 600) return;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.7) {
        if (dx < 0) nextParagraph();
        else previousParagraph();
      }
    }, { passive: true });
  }

  function bindParagraphEvents() {
    bindSwipe();
    const root = getRoot();
    if (!root) return;

    root.querySelectorAll('.reader-word').forEach((wordElement) => {
      if (wordElement.dataset.boundReaderWord === '1') return;
      wordElement.dataset.boundReaderWord = '1';
      wordElement.addEventListener('click', (event) => {
        if (window.__readerSuppressWordTap) {
          window.__readerSuppressWordTap = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (hasNativeSelection()) {
          scheduleSelectionUpdate();
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        const word = wordElement.dataset.word || wordElement.textContent || '';
        const index = Number(wordElement.dataset.readerIndex);
        const offset = Number(wordElement.dataset.readerOffset);
        openWordPanel(
          word,
          Number.isFinite(index) ? index : (getCurrentBook()?.currentParagraph || 0),
          Number.isFinite(offset) ? offset : null,
        );
        return false;
      }, { capture: true });
    });

    root.querySelectorAll('.reader-action-btn').forEach((button) => {
      if (button.dataset.boundReaderAction === '1') return;
      button.dataset.boundReaderAction = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        const action = button.dataset.readerAction;
        const index = Number(button.dataset.readerIndex);
        runAction(event, action, Number.isFinite(index) ? index : null);
        return false;
      }, { capture: true });
    });

    root.querySelectorAll('.reader-paragraph').forEach((paragraph) => {
      if (paragraph.dataset.boundReaderSelect === '1') return;
      paragraph.dataset.boundReaderSelect = '1';
      paragraph.addEventListener('click', (event) => {
        if (event.target?.closest?.('.reader-action-btn, .reader-word, details, summary, button, input, textarea, select, a')) return;
        const index = Number(paragraph.dataset.p);
        if (!Number.isFinite(index)) return;
        selectParagraph(index);
      });
    });
  }

  function installActionDelegation() {
    if (window.__readerActionDelegationInstalled) return;
    window.__readerActionDelegationInstalled = true;
    document.addEventListener('click', (event) => {
      const button = event.target?.closest?.('.reader-action-btn');
      if (!button || event.defaultPrevented || button.dataset.boundReaderAction === '1') return;
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

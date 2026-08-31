#!/usr/bin/env python3
from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# The active swipe owner is reader/interactions.js. chapter-render-next binds it
# before the legacy reader-app.js handler, and both use the same dataset guard.
p = Path('js/reader/interactions.js')
s = read(p)
old = """  function bindSwipe() {
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
      // that synthetic click select a paragraph immediately afterwards.
      if (moved) suppressClickUntil = Date.now() + 350;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.7) {
        suppressClickUntil = Date.now() + 450;
        if (dx < 0) nextParagraph();
        else previousParagraph();
      }
    }, { passive: true });
  }
"""
new = """  function bindSwipe() {
    const root = getRoot();
    if (!root || root.dataset.boundReaderSwipe === '1') return;
    root.dataset.boundReaderSwipe = '1';
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let startedAt = 0;
    let moved = false;
    let horizontalPageGesture = false;
    const pagesMode = () => !!document.querySelector('#reader-reading-view .rd-scroll.rd-pages-mode');

    root.addEventListener('touchstart', (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = lastX = touch.clientX;
      startY = lastY = touch.clientY;
      startedAt = Date.now();
      moved = false;
      horizontalPageGesture = false;
      // Phrase ranging is not a valid owner of gestures in page mode. A lost
      // pointerup/pointercancel could leave this global true and every later
      // touchend would then be discarded.
      if (pagesMode()) window.__readerRanging = false;
    }, { passive: true });

    root.addEventListener('touchmove', (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      lastX = touch.clientX;
      lastY = touch.clientY;
      const dx = lastX - startX;
      const dy = lastY - startY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
      if (pagesMode() && Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        horizontalPageGesture = true;
        // Once this is clearly a horizontal page turn, do not let WebView's
        // text-selection/scroll arbitration steal the rest of the gesture.
        event.preventDefault();
      }
    }, { capture: true, passive: false });

    root.addEventListener('touchend', (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const inPagesMode = pagesMode();
      // A stale range flag may still protect text selection in scroll mode,
      // but it must never make page mode permanently inert.
      if (window.__readerRanging && !inPagesMode) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const elapsed = Date.now() - startedAt;
      const maxDurationMs = inPagesMode ? 2200 : 600;
      if (elapsed > maxDurationMs) return;
      if (moved || horizontalPageGesture) suppressClickUntil = Date.now() + 350;
      const minDistance = inPagesMode ? 48 : 70;
      const directionRatio = inPagesMode ? 1.2 : 1.7;
      if (Math.abs(dx) > minDistance && Math.abs(dx) > Math.abs(dy) * directionRatio) {
        suppressClickUntil = Date.now() + 550;
        window.__readerRanging = false;
        if (dx < 0) nextParagraph();
        else previousParagraph();
      }
    }, { passive: true });

    root.addEventListener('touchcancel', () => {
      horizontalPageGesture = false;
      moved = false;
      if (pagesMode()) window.__readerRanging = false;
    }, { passive: true });
  }
"""
s = replace_once(s, old, new, 'active Android swipe handler')
write(p, s)


# A page turn is a user decision. Same-chapter lexical/context re-renders are
# allowed to rebuild page wrappers during the CSS animation, but not cancel it.
p = Path('js/reader/pages-mode.js')
s = read(p)
old = """    const turnGeneration = paginationGeneration;
    const turnPages = pages;
    const turnChapterText = getChapterText();
    const directionClass = delta > 0 ? 'rd-page-forward' : 'rd-page-backward';
    const finishTurn = () => {
"""
new = """    const turnGeneration = paginationGeneration;
    const turnPages = pages;
    const turnChapterText = getChapterText();
    const turnBookId = String(turnChapterText?.dataset?.readerBookId || '');
    const turnChapter = String(turnChapterText?.dataset?.renderedChapter || '');
    const targetParagraph = nextPage.start;
    const directionClass = delta > 0 ? 'rd-page-forward' : 'rd-page-backward';
    const finishTurn = () => {
"""
s = replace_once(s, old, new, 'capture durable page target')
old = """      if (stale) {
        clearTurnClasses(curPage.el);
        clearTurnClasses(nextPage.el);
        console.warn('[reader pages] ignored stale page-turn callback', {
          turnGeneration,
          currentGeneration: paginationGeneration,
        });
        return;
      }
"""
new = """      if (stale) {
        clearTurnClasses(curPage.el);
        clearTurnClasses(nextPage.el);
        animating = false;
        const liveRoot = getChapterText();
        const sameLogicalChapter = !!liveRoot
          && String(liveRoot.dataset?.readerBookId || '') === turnBookId
          && String(liveRoot.dataset?.renderedChapter || '') === turnChapter;
        if (sameLogicalChapter && Number.isInteger(targetParagraph)) {
          // Dictionary/gloss/background work may repaint this same chapter.
          // Re-commit the page turn by paragraph identity against the live DOM.
          try { setActiveParagraphIndex(targetParagraph); } catch (error) {
            console.warn('[reader pages] failed to recover same-chapter page turn', error?.message || error);
          }
          console.info('[reader pages] recovered page turn across same-chapter rebuild', {
            targetParagraph,
            turnGeneration,
            currentGeneration: paginationGeneration,
          });
        } else {
          // A real TOC/book change still wins over an old animation callback.
          console.warn('[reader pages] ignored stale page-turn callback after chapter/book change', {
            turnGeneration,
            currentGeneration: paginationGeneration,
          });
        }
        return;
      }
"""
s = replace_once(s, old, new, 'same-chapter animation race recovery')
write(p, s)

print('toc122 Android page-turn reliability patch applied')

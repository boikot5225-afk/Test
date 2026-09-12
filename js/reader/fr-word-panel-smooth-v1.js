// toc138 — keep French word-card opening off the chapter-render hot path.
// reader-app already repaints the tapped paragraph synchronously. Its legacy
// follow-up renderReaderChapter() on the very next animation frame needlessly
// rebuilds the whole chapter and is visible as a hitch on Android.

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
}

function install() {
  const original = window.readerOpenWordPanel;
  if (typeof original !== 'function') return false;
  if (original.__toc138FrenchSmoothPanel) return true;

  function smoothFrenchOpenWordPanel(...args) {
    if (currentLang() !== 'fr') return original.apply(this, args);

    const nativeRaf = window.requestAnimationFrame.bind(window);
    const liveRaf = window.requestAnimationFrame;
    let suppressed = false;
    window.requestAnimationFrame = function toc138Raf(callback) {
      let source = '';
      try { source = Function.prototype.toString.call(callback); } catch {}
      if (!suppressed && /renderReaderChapter/.test(source)) {
        suppressed = true;
        window.__toc138FrenchSuppressedChapterRepaints =
          Number(window.__toc138FrenchSuppressedChapterRepaints || 0) + 1;
        return nativeRaf(() => {});
      }
      return nativeRaf(callback);
    };

    try {
      // Async functions execute synchronously until their first await. The
      // legacy full-chapter RAF is queued before that await, so restoring RAF
      // immediately after this call does not affect unrelated animations.
      return original.apply(this, args);
    } finally {
      window.requestAnimationFrame = liveRaf;
    }
  }

  smoothFrenchOpenWordPanel.__toc138FrenchSmoothPanel = true;
  smoothFrenchOpenWordPanel.__toc138Original = original;
  window.readerOpenWordPanel = smoothFrenchOpenWordPanel;
  return true;
}

function boot() {
  if (install()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (install() || attempts > 80) clearInterval(timer);
  }, 100);
}

if (typeof window !== 'undefined' && !window.__readerFrWordPanelSmoothV1) {
  window.__readerFrWordPanelSmoothV1 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', install);
}

export { install };

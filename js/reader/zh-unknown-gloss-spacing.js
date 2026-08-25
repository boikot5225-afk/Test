// Cosmetic spacing + mode bridge for the optional Chinese unknown-word aid.
// It does not touch vocabulary state, AI, navigation, page position or word DOM.

const BASE_PINYIN_MODE_KEY = 'an2_reader_zh_pinyin_mode_v1';

function basePinyinMode() {
  try { return localStorage.getItem(BASE_PINYIN_MODE_KEY) || 'unknown'; }
  catch { return 'unknown'; }
}

function syncPinyinVisibility() {
  const view = document.getElementById('reader-reading-view');
  if (!view) return;
  view.classList.toggle('rd-zh-gloss-pinyin-off', basePinyinMode() === 'off');
}

function syncLegacyRubyMode(next) {
  const customOn = next === 'unknown';
  try { localStorage.setItem(BASE_PINYIN_MODE_KEY, customOn ? 'learning' : 'off'); } catch {}
  syncPinyinVisibility();
}

function installModeBridge() {
  const html = document.documentElement;
  if (html?.dataset?.zhGlossModeBridge !== '1') {
    if (html) html.dataset.zhGlossModeBridge = '1';

    // Run before the custom mode button's own handler. That handler performs a
    // chapter render, so the legacy ruby state must already be correct by then.
    document.addEventListener('click', (event) => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      const customButton = target?.closest?.('.rd-zh-gloss-mode');
      if (customButton) syncLegacyRubyMode(customButton.dataset.mode || 'off');
    }, true);

    // The top 拼 button owns the legacy pinyin mode. After it cycles, reflect
    // its new state in our overlay as well. In 拼× the Russian gloss can remain,
    // but our pinyin lane is hidden too instead of ignoring the user's choice.
    document.addEventListener('click', (event) => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!target?.closest?.('#reader-pinyin-btn')) return;
      setTimeout(syncPinyinVisibility, 0);
    });

    window.addEventListener('storage', (event) => {
      if (event.key === BASE_PINYIN_MODE_KEY) syncPinyinVisibility();
    });
  }

  // Keep programmatic calls consistent with the two buttons as well.
  const current = window.readerSetZhUnknownGlossMode;
  if (typeof current === 'function' && !current.__zhGlossModeBridge) {
    const wrapped = async (next) => {
      syncLegacyRubyMode(next);
      return current(next);
    };
    wrapped.__zhGlossModeBridge = true;
    window.readerSetZhUnknownGlossMode = wrapped;
  }

  syncPinyinVisibility();
}

function injectSpacingStyle() {
  if (document.getElementById('rd-zh-unknown-gloss-spacing-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-zh-unknown-gloss-spacing-style';
  style.textContent = `
    /* Keep a predictable vertical lane above/below every Chinese text line. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.18 !important;
    }

    /* Keep both annotations visually attached to their own Hanzi. The extra
       line-height above creates the breathing room toward neighbouring lines. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::before {
      bottom: calc(100% + .045em) !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::after {
      top: calc(100% + .045em) !important;
    }

    /* Respect the existing top 拼 control. Our overlay must not keep showing
       pinyin after the legacy control is explicitly switched to off. */
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"] .rw-zh-gloss-wrap::before {
      content: '' !important;
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function install() {
  injectSpacingStyle();
  installModeBridge();
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
  window.addEventListener('pageshow', install);
}

export { injectSpacingStyle, syncPinyinVisibility, syncLegacyRubyMode };

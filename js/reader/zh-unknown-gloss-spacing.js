// Chinese Unknown mode bridge only.
// toc91 deliberately owns NO spacing/pinyin presentation here. Reader's native
// ruby renderer stays authoritative and zh-readable-inline paints only Russian.

const BASE_PINYIN_MODE_KEY = 'an2_reader_zh_pinyin_mode_v1';
const RETIRED_STYLE_ID = 'rd-zh-unknown-gloss-spacing-style';

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

    document.addEventListener('click', (event) => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      const customButton = target?.closest?.('.rd-zh-gloss-mode');
      if (customButton) syncLegacyRubyMode(customButton.dataset.mode || 'off');
    }, true);

    document.addEventListener('click', (event) => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!target?.closest?.('#reader-pinyin-btn')) return;
      setTimeout(syncPinyinVisibility, 0);
    });

    window.addEventListener('storage', (event) => {
      if (event.key === BASE_PINYIN_MODE_KEY) syncPinyinVisibility();
    });
  }

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

// Compatibility export: old callers may still invoke this function. It now
// only removes the retired style instead of injecting geometry-changing CSS.
function injectSpacingStyle() {
  document.getElementById(RETIRED_STYLE_ID)?.remove();
}

function install() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
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

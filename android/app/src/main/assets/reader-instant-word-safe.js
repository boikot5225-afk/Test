(() => {
  'use strict';
  if (window.__readerInstantWordSafeInstalled) return;
  window.__readerInstantWordSafeInstalled = true;

  const WORD_CACHE_KEY = 'an2_instant_translate_word_cache_v1';

  function currentSurface() {
    return String(document.getElementById('reader-word-title')?.textContent || '').trim();
  }

  function currentLang() {
    const panel = document.getElementById('reader-word-panel');
    const view = document.getElementById('reader-reading-view');
    return String(panel?.dataset?.lang || view?.dataset?.readerLang || view?.lang || '').trim().toLowerCase();
  }

  function wordKey(surface, lang) {
    return `${String(lang || '').trim().toLowerCase()}:${String(surface || '').trim().toLowerCase()}`;
  }

  function cachedTranslation(surface, lang) {
    try {
      const cache = JSON.parse(localStorage.getItem(WORD_CACHE_KEY) || '{}');
      const value = cache?.[wordKey(surface, lang)];
      return typeof value === 'string'
        ? value.trim()
        : String(value?.ru || '').trim();
    } catch (_) {
      return '';
    }
  }

  function relabelInstantButton() {
    const panel = document.getElementById('reader-word-panel');
    if (!panel) return;
    panel.querySelectorAll('.reader-word-actions button').forEach(button => {
      if (/DeepSeek|↻\s*Instant/i.test(String(button.textContent || ''))) {
        button.textContent = '↻ Instant';
        button.dataset.instantWordTranslate = '1';
      }
    });
    panel.querySelectorAll('.reader-analysis-pinyin.muted').forEach(el => {
      const text = String(el.textContent || '');
      if (/DeepSeek/i.test(text)) el.textContent = text.replace(/DeepSeek/gi, 'Instant');
    });
  }

  function applyCachedTranslation(surface, lang) {
    const ru = cachedTranslation(surface, lang);
    if (!ru || currentSurface() !== surface) return;
    const panel = document.getElementById('reader-word-panel');
    if (!panel) return;
    const ruEl = panel.querySelector('.reader-analysis-ru');
    if (ruEl) {
      ruEl.textContent = ru;
      ruEl.dataset.instantTranslate = '1';
    }
    const input = panel.querySelector('#reader-word-ru');
    if (input) input.value = ru;
  }

  // Restore cached Instant results without consuming Reader's shared metadata
  // event. The translation bridge itself owns the manual-only rule; swallowing
  // this event would also disable unrelated Known/Unknown candidate listeners.
  document.addEventListener('reader-word-analysis-ready', event => {
    const detail = event?.detail || {};
    const surface = String(detail.surface || currentSurface() || '').trim();
    const lang = String(detail.lang || currentLang() || '').trim().toLowerCase();
    setTimeout(() => {
      relabelInstantButton();
      applyCachedTranslation(surface, lang);
    }, 0);
  }, true);

  // The panel itself is created lazily. Relabel once more on pointer/click so the
  // manual action always reads Instant even if the card was restored from an older
  // DOM snapshot before reader-word-analysis-ready fired.
  document.addEventListener('pointerdown', event => {
    if (event?.target?.closest?.('#reader-word-panel')) setTimeout(relabelInstantButton, 0);
  }, true);

  console.info('[Instant Translate] word safety guard: manual external lookup only');
})();

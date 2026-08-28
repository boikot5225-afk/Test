(() => {
  'use strict';
  if (window.__readerInstantTranslateBridgeInstalled) return;
  const nativeBridge = window.ReaderInstantTranslate;
  if (!nativeBridge || typeof nativeBridge.translate !== 'function') return;

  const originalFetch = window.fetch.bind(window);
  const originalAlert = typeof window.alert === 'function' ? window.alert.bind(window) : null;
  const pending = new Map();
  const WORD_CACHE_KEY = 'an2_instant_translate_word_cache_v1';
  const WORD_CACHE_LIMIT = 1200;
  let sequence = 0;
  let manualTranslateUntil = 0;
  let manualTranslateMode = '';
  let wordAnalysisGeneration = 0;
  let wordInFlightKey = '';

  function showInstantError(message, timeoutMs = 6500) {
    try {
      let el = document.getElementById('reader-instant-translate-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'reader-instant-translate-status';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', top: '18px', transform: 'translateX(-50%)',
          zIndex: '2147483647', maxWidth: 'calc(100vw - 32px)', padding: '10px 14px',
          borderRadius: '12px', font: '600 14px/1.35 system-ui, sans-serif',
          boxShadow: '0 8px 28px rgba(0,0,0,.35)', textAlign: 'center',
          pointerEvents: 'none', transition: 'opacity .18s ease',
          background: '#5b1d1d', color: '#fff',
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = String(message || 'Instant Translate не сработал');
      el.style.opacity = '1';
      clearTimeout(el.__readerInstantTimer);
      el.__readerInstantTimer = setTimeout(() => { el.style.opacity = '0'; }, timeoutMs);
    } catch (_) {}
  }

  function hideLegacyTranslationToast() {
    try {
      const toast = document.getElementById('toast');
      if (!toast) return;
      const text = String(toast.textContent || '');
      if (/DeepSeek\s+переводит\s+абзац/i.test(text)
          || /Перевод\s+добавлен\s+под\s+абзацем/i.test(text)) toast.style.display = 'none';
    } catch (_) {}
  }

  function neutralizeLegacyTranslationUi(mode = '') {
    hideLegacyTranslationToast();
    try {
      if (mode === 'selection') {
        const ru = document.getElementById('reader-sel-ru');
        if (ru && /DeepSeek\s+переводит/i.test(String(ru.textContent || ''))) ru.textContent = '…';
      }
    } catch (_) {}
  }

  function suppressLegacySuccessToast() {
    [0, 60, 140, 260, 500].forEach(delay => setTimeout(hideLegacyTranslationToast, delay));
  }

  function revealActiveParagraphTranslation(attempt = 0) {
    try {
      const details = document.querySelector('#reader-chapter-text .reader-paragraph.active .reader-translation-block');
      if (details) {
        details.open = true;
        const label = details.querySelector('summary span');
        if (label) label.textContent = 'скрыть';
        return;
      }
    } catch (_) {}
    if (attempt < 12) setTimeout(() => revealActiveParagraphTranslation(attempt + 1), 90);
  }

  function currentWordSurface() {
    return String(document.getElementById('reader-word-title')?.textContent || '').trim();
  }

  function currentWordLang() {
    const panel = document.getElementById('reader-word-panel');
    const view = document.getElementById('reader-reading-view');
    return String(panel?.dataset?.lang || view?.dataset?.readerLang || view?.lang || '').trim().toLowerCase();
  }

  function wordKey(surface, lang) {
    return `${String(lang || '').trim().toLowerCase()}:${String(surface || '').trim().toLowerCase()}`;
  }

  function loadWordCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(WORD_CACHE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  function cachedWordTranslation(surface, lang) {
    const item = loadWordCache()[wordKey(surface, lang)];
    if (typeof item === 'string') return item.trim();
    return String(item?.ru || '').trim();
  }

  function rememberWordTranslation(surface, lang, ru) {
    const translation = String(ru || '').trim();
    if (!translation) return;
    try {
      const cache = loadWordCache();
      cache[wordKey(surface, lang)] = { ru: translation, t: Date.now() };
      const entries = Object.entries(cache);
      if (entries.length > WORD_CACHE_LIMIT) {
        entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0))
          .slice(WORD_CACHE_LIMIT).forEach(([key]) => { delete cache[key]; });
      }
      localStorage.setItem(WORD_CACHE_KEY, JSON.stringify(cache));
    } catch (_) {}
  }

  function containsCyrillic(text) {
    return /[\u0400-\u052f]/.test(String(text || ''));
  }

  function usableWordSurface(surface) {
    const text = String(surface || '').trim();
    return !!text && text.length <= 80
      && /[A-Za-zÀ-ÿ\u0400-\u052f\u3040-\u30ff\u3400-\u9fff]/.test(text);
  }

  function wordTranslationIsMissing(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value || value === '—' || value === '-' || value === '…') return true;
    return !containsCyrillic(value);
  }

  function refreshWordInstantUi() {
    try {
      const panel = document.getElementById('reader-word-panel');
      if (!panel) return;
      panel.querySelectorAll('.reader-word-actions button').forEach(button => {
        if (/DeepSeek|↻\s*Instant/i.test(String(button.textContent || ''))
            || button.dataset.instantWordTranslate === '1') {
          button.textContent = '↻ Instant';
          button.dataset.instantWordTranslate = '1';
        }
      });
      panel.querySelectorAll('.reader-analysis-pinyin.muted').forEach(el => {
        const text = String(el.textContent || '');
        if (/DeepSeek/i.test(text)) el.textContent = text.replace(/DeepSeek/gi, 'Instant');
      });
      if (currentWordLang() === 'en') {
        const known = panel.querySelector('#reader-word-known');
        if (known && /DeepSeek/i.test(String(known.textContent || ''))) {
          known.textContent = 'локально · Instant по кнопке';
        }
        const status = panel.querySelector('#reader-word-status');
        if (status && /DeepSeek/i.test(String(status.textContent || ''))) {
          status.textContent = 'Перевода нет — нажми ↻ Instant';
          status.style.color = 'var(--text-muted)';
        }
      }
    } catch (_) {}
  }

  function applyWordTranslation(surface, lang, ru) {
    const translation = String(ru || '').trim();
    if (!translation) return false;
    rememberWordTranslation(surface, lang, translation);

    if (currentWordSurface() !== String(surface || '').trim()) return false;
    const panel = document.getElementById('reader-word-panel');
    if (!panel) return false;
    const ruEl = panel.querySelector('.reader-analysis-ru');
    if (ruEl) {
      ruEl.textContent = translation;
      ruEl.dataset.instantTranslate = '1';
      delete ruEl.dataset.instantPending;
    }
    const input = panel.querySelector('#reader-word-ru');
    if (input) {
      input.value = translation;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }
    const status = panel.querySelector('#reader-word-status');
    if (status) {
      status.style.display = 'block';
      status.style.color = 'var(--good)';
      status.textContent = '✅ Instant: перевод сохранён';
    }
    refreshWordInstantUi();
    return true;
  }

  function currentWordCardMissingRussian(surface) {
    if (currentWordSurface() !== String(surface || '').trim()) return false;
    const ruEl = document.querySelector('#reader-word-panel .reader-analysis-ru');
    return !!ruEl && wordTranslationIsMissing(ruEl.textContent);
  }

  function currentEnglishPlaceholder(payload = {}) {
    const panel = document.getElementById('reader-word-panel');
    const surface = currentWordSurface() || String(payload.word || payload.surface || '').trim();
    const inputRu = String(panel?.querySelector('#reader-word-ru')?.value || '').trim();
    const cardRu = String(panel?.querySelector('.reader-analysis-ru')?.textContent || '').trim();
    const cached = cachedWordTranslation(surface, 'en');
    const ru = containsCyrillic(inputRu) ? inputRu
      : containsCyrillic(cardRu) ? cardRu
        : containsCyrillic(cached) ? cached : '';
    return {
      pos: String(panel?.querySelector('#reader-word-pos')?.value || 'other'),
      lemma: String(panel?.querySelector('#reader-word-lemma')?.value || surface || '').trim(),
      word: surface,
      surface,
      ru,
      level: String(panel?.querySelector('#reader-word-level')?.value || 'A2'),
      form_note: '',
      note: '',
      _source: 'instant_manual_only',
    };
  }

  async function translateWord(surface, lang, { force = false, silent = true } = {}) {
    const cleanSurface = String(surface || '').trim();
    const cleanLang = String(lang || currentWordLang() || '').trim().toLowerCase();
    if (!usableWordSurface(cleanSurface)) return;
    const key = wordKey(cleanSurface, cleanLang);

    if (!force) {
      const cached = cachedWordTranslation(cleanSurface, cleanLang);
      if (cached) {
        applyWordTranslation(cleanSurface, cleanLang, cached);
        return;
      }
      if (!currentWordCardMissingRussian(cleanSurface)) return;
    }

    if (wordInFlightKey === key || pending.size) return;
    wordInFlightKey = key;
    const ruEl = currentWordSurface() === cleanSurface
      ? document.querySelector('#reader-word-panel .reader-analysis-ru') : null;
    const previous = String(ruEl?.textContent || '—');
    if (ruEl) {
      ruEl.textContent = '…';
      ruEl.dataset.instantPending = '1';
    }

    try {
      const translated = await nativeTranslate({
        text: cleanSurface, sourceLang: cleanLang, targetLang: 'ru', mode: 'word',
      });
      const ru = String(translated?.ru || '').trim();
      if (!ru) throw new Error('Instant Translate вернул пустой перевод слова');
      applyWordTranslation(cleanSurface, cleanLang, ru);
    } catch (error) {
      if (currentWordSurface() === cleanSurface && ruEl?.isConnected) {
        ruEl.textContent = previous || '—';
        delete ruEl.dataset.instantPending;
      }
      console.warn('[Instant Translate word]', error?.code || '', error?.message || error);
      if (!silent) showInstantError(String(error?.message || error || 'Перевод слова не сработал'));
    } finally {
      if (wordInFlightKey === key) wordInFlightKey = '';
    }
  }

  function scheduleWordFallback(detail = {}) {
    const generation = ++wordAnalysisGeneration;
    const surface = String(detail.surface || '').trim();
    const lang = String(detail.lang || currentWordLang() || '').trim().toLowerCase();
    if (!usableWordSurface(surface)) return;

    setTimeout(() => {
      if (generation !== wordAnalysisGeneration || currentWordSurface() !== surface) return;
      refreshWordInstantUi();
      const cached = cachedWordTranslation(surface, lang);
      if (cached) applyWordTranslation(surface, lang, cached);
      // Important: no automatic external app launch here. Missing translations
      // are filled only after an explicit ↻ Instant tap.
    }, 80);
  }

  document.addEventListener('reader-word-analysis-ready', event => {
    scheduleWordFallback(event?.detail || {});
  });

  window.readerInstantTranslateSelectedWord = () => {
    const surface = currentWordSurface();
    const lang = currentWordLang();
    return translateWord(surface, lang, { force: true, silent: false });
  };

  function markManualTranslation(event) {
    const target = event?.target;
    if (!target?.closest) return;

    const wordButton = target.closest('#reader-word-panel .reader-word-actions button');
    if (wordButton && (/DeepSeek|Instant/i.test(String(wordButton.textContent || ''))
        || wordButton.dataset.instantWordTranslate === '1')) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTimeout(() => window.readerInstantTranslateSelectedWord?.(), 0);
      return;
    }

    const paragraphButton = target.closest('.reader-action-btn[data-reader-action="translate"]');
    const selectionButton = target.closest('#reader-sel-btn');
    const moreMenuButton = target.closest('#reader-more-sheet .rd-menu');
    const isMoreMenuTranslate = !!moreMenuButton
      && /перевод\s+абзаца/i.test(String(moreMenuButton.textContent || ''));

    if (paragraphButton || isMoreMenuTranslate || selectionButton) {
      manualTranslateUntil = Date.now() + 5000;
      manualTranslateMode = selectionButton ? 'selection' : 'paragraph';
      setTimeout(() => neutralizeLegacyTranslationUi(manualTranslateMode), 0);
      setTimeout(() => neutralizeLegacyTranslationUi(manualTranslateMode), 80);
    }
  }

  document.addEventListener('click', markManualTranslation, true);

  if (originalAlert) {
    window.alert = function readerInstantTranslateAlert(message) {
      let text = String(message ?? '');
      if (/DeepSeek\s+не\s+сработал\s+для\s+перевода\s+абзаца/i.test(text)) {
        text = text.replace(/DeepSeek/gi, 'Instant Translate');
      }
      return originalAlert(text);
    };
  }

  window.__readerInstantTranslateResolve = (requestId, ok, payloadJson) => {
    const entry = pending.get(String(requestId || ''));
    if (!entry) return;
    pending.delete(String(requestId || ''));
    clearTimeout(entry.timer);
    let payload = {};
    try { payload = JSON.parse(String(payloadJson || '{}')); } catch (_) {}
    if (ok) entry.resolve(payload);
    else entry.reject(Object.assign(new Error(payload.message || 'Instant Translate не сработал'), {
      code: payload.code || 'instant_translate',
    }));
  };

  function isReaderAiCallable(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      return /\/readerAI\/?$/i.test(parsed.pathname);
    } catch (_) { return String(url || '').includes('/readerAI'); }
  }

  function blockedBackgroundTranslationResponse() {
    return new Response(JSON.stringify({
      error: { message: 'Фоновый перевод отключён для внешнего Instant Translate', code: 'instant_translate_background_skipped' },
    }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  function syntheticEnglishWordResponse(payload) {
    const result = currentEnglishPlaceholder(payload);
    setTimeout(refreshWordInstantUi, 0);
    setTimeout(refreshWordInstantUi, 100);
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function nativeTranslate(payload) {
    return new Promise((resolve, reject) => {
      if (pending.size) {
        reject(Object.assign(new Error('Предыдущий перевод ещё выполняется'), { code: 'instant_translate_busy' }));
        return;
      }
      const requestId = `it-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      const isWord = String(payload?.mode || '') === 'word';
      const timeoutMs = isWord ? 10_000 : 65_000;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        try { nativeBridge.cancel?.(requestId); } catch (_) {}
        reject(Object.assign(new Error(`Instant Translate не вернул результат за ${Math.round(timeoutMs / 1000)} секунд`), {
          code: 'instant_translate_timeout',
        }));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        nativeBridge.translate(requestId, JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        try { nativeBridge.cancel?.(requestId); } catch (_) {}
        reject(error);
      }
    });
  }

  window.fetch = async function readerInstantTranslateFetch(input, init = undefined) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
    if (method !== 'POST' || !isReaderAiCallable(url) || typeof init?.body !== 'string') {
      return originalFetch(input, init);
    }

    let callableBody;
    try { callableBody = JSON.parse(init.body); } catch (_) { return originalFetch(input, init); }
    const payload = callableBody?.data;
    if (!payload) return originalFetch(input, init);

    // English word cards are local-first and manual-Instant-only. The legacy
    // reader still tries reader_word automatically on a miss (and even only
    // to obtain IPA). Return the local card state immediately instead of ever
    // sending that English word to DeepSeek. ↻ Instant is the only network/UI
    // translation path for an EN word after this point.
    if (payload.task === 'reader_word'
        && String(payload.sourceLang || '').trim().toLowerCase() === 'en') {
      return syntheticEnglishWordResponse(payload);
    }

    if (payload.task !== 'translate_paragraph' || !String(payload.text || '').trim()) {
      return originalFetch(input, init);
    }

    if (Date.now() > manualTranslateUntil) return blockedBackgroundTranslationResponse();
    const requestMode = manualTranslateMode || 'paragraph';
    manualTranslateUntil = 0;
    manualTranslateMode = '';
    neutralizeLegacyTranslationUi(requestMode);

    try {
      const translated = await nativeTranslate({
        text: String(payload.text || ''),
        sourceLang: String(payload.sourceLang || payload.lang || ''),
        targetLang: String(payload.targetLang || 'ru'),
        mode: 'paragraph',
      });
      const ru = String(translated?.ru || '').trim();
      if (!ru) throw new Error('Instant Translate вернул пустой текст');
      if (requestMode === 'paragraph') {
        setTimeout(() => revealActiveParagraphTranslation(0), 80);
        suppressLegacySuccessToast();
      }
      return new Response(JSON.stringify({ result: { ru, provider: 'instant_translate_installed_app' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      const reason = String(error?.message || error || 'неизвестная ошибка').slice(0, 220);
      console.warn('[Instant Translate]', error?.code || '', reason);
      showInstantError(reason);
      return new Response(JSON.stringify({ error: { message: reason, code: error?.code || 'instant_translate' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  };

  window.__readerInstantTranslateBridgeInstalled = true;
  console.info('[Instant Translate] hidden paragraph + manual word bridge active');
})();
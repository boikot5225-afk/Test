(() => {
  'use strict';
  if (window.__readerInstantTranslateBridgeInstalled) return;
  const nativeBridge = window.ReaderInstantTranslate;
  if (!nativeBridge || typeof nativeBridge.translate !== 'function') return;

  const originalFetch = window.fetch.bind(window);
  const originalAlert = typeof window.alert === 'function' ? window.alert.bind(window) : null;
  const pending = new Map();
  let sequence = 0;
  let manualTranslateUntil = 0;
  let manualTranslateMode = '';

  function showInstantError(message, timeoutMs = 6500) {
    try {
      let el = document.getElementById('reader-instant-translate-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'reader-instant-translate-status';
        Object.assign(el.style, {
          position: 'fixed',
          left: '50%',
          top: '18px',
          transform: 'translateX(-50%)',
          zIndex: '2147483647',
          maxWidth: 'calc(100vw - 32px)',
          padding: '10px 14px',
          borderRadius: '12px',
          font: '600 14px/1.35 system-ui, sans-serif',
          boxShadow: '0 8px 28px rgba(0,0,0,.35)',
          textAlign: 'center',
          pointerEvents: 'none',
          transition: 'opacity .18s ease',
          background: '#5b1d1d',
          color: '#fff',
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
          || /Перевод\s+добавлен\s+под\s+абзацем/i.test(text)) {
        toast.style.display = 'none';
      }
    } catch (_) {}
  }

  function neutralizeLegacyTranslationUi(mode = '') {
    hideLegacyTranslationToast();
    try {
      if (mode === 'selection') {
        const ru = document.getElementById('reader-sel-ru');
        if (ru && /DeepSeek\s+переводит/i.test(String(ru.textContent || ''))) {
          ru.textContent = '…';
        }
      }
    } catch (_) {}
  }

  function suppressLegacySuccessToast() {
    [0, 60, 140, 260, 500].forEach(delay => setTimeout(hideLegacyTranslationToast, delay));
  }

  function revealActiveParagraphTranslation(attempt = 0) {
    try {
      const details = document.querySelector(
        '#reader-chapter-text .reader-paragraph.active .reader-translation-block'
      );
      if (details) {
        details.open = true;
        const label = details.querySelector('summary span');
        if (label) label.textContent = 'скрыть';
        return;
      }
    } catch (_) {}
    if (attempt < 12) setTimeout(() => revealActiveParagraphTranslation(attempt + 1), 90);
  }

  function markManualTranslation(event) {
    const target = event?.target;
    if (!target?.closest) return;

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
    } catch (_) {
      return String(url || '').includes('/readerAI');
    }
  }

  function blockedBackgroundTranslationResponse() {
    return new Response(JSON.stringify({
      error: {
        message: 'Фоновый перевод отключён для внешнего Instant Translate',
        code: 'instant_translate_background_skipped',
      },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function nativeTranslate(payload) {
    return new Promise((resolve, reject) => {
      if (pending.size) {
        reject(Object.assign(new Error('Предыдущий перевод ещё выполняется'), {
          code: 'instant_translate_busy',
        }));
        return;
      }

      const requestId = `it-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        try { nativeBridge.cancel?.(requestId); } catch (_) {}
        reject(Object.assign(new Error('Instant Translate не вернул результат за 65 секунд'), {
          code: 'instant_translate_timeout',
        }));
      }, 65000);
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
    if (!payload || payload.task !== 'translate_paragraph' || !String(payload.text || '').trim()) {
      return originalFetch(input, init);
    }

    if (Date.now() > manualTranslateUntil) {
      return blockedBackgroundTranslationResponse();
    }
    const requestMode = manualTranslateMode || 'paragraph';
    manualTranslateUntil = 0;
    manualTranslateMode = '';
    neutralizeLegacyTranslationUi(requestMode);

    try {
      const translated = await nativeTranslate({
        text: String(payload.text || ''),
        sourceLang: String(payload.sourceLang || payload.lang || ''),
        targetLang: String(payload.targetLang || 'ru'),
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
      return new Response(JSON.stringify({
        error: { message: reason, code: error?.code || 'instant_translate' },
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  };

  window.__readerInstantTranslateBridgeInstalled = true;
  console.info('[Instant Translate] hidden installed-app bridge active');
})();

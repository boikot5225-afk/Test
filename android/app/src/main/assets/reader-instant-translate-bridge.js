(() => {
  'use strict';
  if (window.__readerInstantTranslateBridgeInstalled) return;
  const nativeBridge = window.ReaderInstantTranslate;
  if (!nativeBridge || typeof nativeBridge.translate !== 'function') return;

  const originalFetch = window.fetch.bind(window);
  const pending = new Map();
  let sequence = 0;

  function showInstantNotice(message, error = false, timeoutMs = 4200) {
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
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = String(message || '');
      el.style.background = error ? '#5b1d1d' : '#173d2a';
      el.style.color = '#fff';
      el.style.opacity = '1';
      clearTimeout(el.__readerInstantTimer);
      el.__readerInstantTimer = setTimeout(() => { el.style.opacity = '0'; }, timeoutMs);
    } catch (_) {}
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

  function nativeTranslate(payload) {
    return new Promise((resolve, reject) => {
      const requestId = `it-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error('тайм-аут Instant Translate'), { code: 'instant_translate_timeout' }));
      }, 65000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        nativeBridge.translate(requestId, JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
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

    showInstantNotice('Открываю Instant Translate…', false, 2500);
    try {
      const translated = await nativeTranslate({
        text: String(payload.text || ''),
        sourceLang: String(payload.sourceLang || payload.lang || ''),
        targetLang: String(payload.targetLang || 'ru'),
      });
      const ru = String(translated?.ru || '').trim();
      if (!ru) throw new Error('Instant Translate вернул пустой текст');
      showInstantNotice('Instant Translate: перевод получен', false, 2200);
      return new Response(JSON.stringify({ result: { ru, provider: 'instant_translate_installed_app' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      const reason = String(error?.message || error || 'неизвестная ошибка').slice(0, 220);
      console.warn('[Instant Translate]', error?.code || '', reason);
      showInstantNotice(`Instant Translate: ${reason}`, true, 8000);

      // Deliberately DO NOT call the old Reader/DeepSeek backend here. toc65 is
      // a clean compatibility test: either the installed Instant Translate app
      // returns the paragraph, or the translation request fails visibly.
      return new Response(JSON.stringify({
        error: { message: `Instant Translate: ${reason}`, code: error?.code || 'instant_translate' }
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  };

  window.__readerInstantTranslateBridgeInstalled = true;
  showInstantNotice('Instant Translate: мост активен', false, 3500);
  console.info('[Instant Translate] installed-app bridge active');
})();

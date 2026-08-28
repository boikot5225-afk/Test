(() => {
  'use strict';
  if (window.__readerInstantTranslateBridgeInstalled) return;
  const nativeBridge = window.ReaderInstantTranslate;
  if (!nativeBridge || typeof nativeBridge.translate !== 'function') return;

  const originalFetch = window.fetch.bind(window);
  const pending = new Map();
  let sequence = 0;

  window.__readerInstantTranslateResolve = (requestId, ok, payloadJson) => {
    const entry = pending.get(String(requestId || ''));
    if (!entry) return;
    pending.delete(String(requestId || ''));
    clearTimeout(entry.timer);
    let payload = {};
    try { payload = JSON.parse(String(payloadJson || '{}')); } catch (_) {}
    if (ok) entry.resolve(payload);
    else entry.reject(Object.assign(new Error(payload.message || 'Instant Translate AI failed'), {
      code: payload.code || 'instant_ai',
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
        reject(Object.assign(new Error('Instant Translate AI timeout'), { code: 'instant_ai_timeout' }));
      }, 45000);
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

    try {
      const translated = await nativeTranslate({
        text: String(payload.text || ''),
        sourceLang: String(payload.sourceLang || payload.lang || ''),
        targetLang: String(payload.targetLang || 'ru'),
      });
      const ru = String(translated?.ru || '').trim();
      if (!ru) throw new Error('Instant Translate AI returned empty text');
      return new Response(JSON.stringify({ result: { ru, provider: 'instant_translate_ai' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      console.warn('[Instant Translate AI] fallback to DeepSeek:', error?.code || '', error?.message || error);
      return originalFetch(input, init);
    }
  };

  window.__readerInstantTranslateBridgeInstalled = true;
  console.info('[Instant Translate AI] native translation interceptor installed');
})();

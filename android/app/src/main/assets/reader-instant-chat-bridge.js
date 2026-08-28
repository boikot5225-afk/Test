(() => {
  'use strict';
  if (window.__readerInstantChatBridgeInstalled) return;
  const nativeBridge = window.ReaderInstantChat;
  if (!nativeBridge || typeof nativeBridge.analyze !== 'function') return;

  const originalFetch = window.fetch.bind(window);
  const pending = new Map();
  const DONE_MARKER = '[RAI_DONE]';
  let sequence = 0;

  function isReaderAiCallable(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      return /\/readerAI\/?$/i.test(parsed.pathname);
    } catch (_) {
      return String(url || '').includes('/readerAI');
    }
  }

  function showChatError(message, timeoutMs = 7500) {
    try {
      let el = document.getElementById('reader-instant-chat-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'reader-instant-chat-status';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', top: '18px', transform: 'translateX(-50%)',
          zIndex: '2147483647', maxWidth: 'calc(100vw - 32px)', padding: '10px 14px',
          borderRadius: '12px', font: '600 14px/1.35 system-ui,sans-serif',
          boxShadow: '0 8px 28px rgba(0,0,0,.35)', textAlign: 'center',
          pointerEvents: 'none', transition: 'opacity .18s ease',
          background: '#5b1d1d', color: '#fff',
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = String(message || 'Instant AI Chat не сработал');
      el.style.opacity = '1';
      clearTimeout(el.__timer);
      el.__timer = setTimeout(() => { el.style.opacity = '0'; }, timeoutMs);
    } catch (_) {}
  }

  function relabelLegacyGrammarToast() {
    try {
      const toast = document.getElementById('toast');
      if (!toast) return;
      const text = String(toast.textContent || '');
      if (/DeepSeek\s+разбирает\s+предложение/i.test(text)) {
        toast.textContent = '🧩 Instant AI разбирает предложение…';
      }
    } catch (_) {}
  }

  function buildGrammarPrompt(payload) {
    const text = String(payload?.text || '').trim();
    const lang = String(payload?.sourceLang || payload?.lang || '').trim().toLowerCase();
    const readingKey = lang === 'zh' ? 'pinyin' : (lang === 'ja' ? 'reading' : '');
    const partExample = readingKey
      ? `{"text":"фрагмент","${readingKey}":"чтение","what":"роль/смысл","why":"кратко почему"}`
      : '{"text":"фрагмент","what":"роль/смысл","why":"кратко почему"}';

    return [
      'Кратко разбери грамматику предложения для русскоязычного ученика.',
      'Ответь ТОЛЬКО одним компактным JSON без Markdown и без текста вокруг:',
      `{"parts":[${partExample}],"whys":[{"q":"важный вопрос","a":"короткий ответ"}],"summary":"структура предложения"}`,
      'Правила: parts 2–5; what до 8 слов; why до 14 слов; whys максимум 2; summary до 20 слов. Не повторяй очевидное и не пиши длинных лекций.',
      `Сразу после закрывающей } допиши ${DONE_MARKER}.`,
      'Текст:',
      text,
    ].join('\n');
  }

  function looksLikeVendorError(value) {
    const text = String(value || '').toLowerCase().replace(/ё/g, 'е');
    return text.includes('что-то пошло не так')
      || text.includes('что то пошло не так')
      || text.includes('попробуйте снова')
      || text.includes('попробуйте еще раз')
      || text.includes('something went wrong')
      || text.includes('try again')
      || text.includes('network error')
      || text.includes('no connection')
      || text.includes('ошибка сети')
      || text.includes('нет соединения');
  }

  function stripCodeFence(raw) {
    let text = String(raw || '').trim();
    text = text.replaceAll(DONE_MARKER, '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
    return text;
  }

  function unwrapGrammarObject(value) {
    let current = value;
    for (let i = 0; i < 4; i++) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) break;
      if (Array.isArray(current.parts) || Array.isArray(current.whys) || current.summary) break;
      const nested = current.data || current.result || current.analysis;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        current = nested;
        continue;
      }
      const textish = current.text || current.answer || current.content;
      if (typeof textish === 'string' && textish.trim()) {
        try {
          current = JSON.parse(stripCodeFence(textish));
          continue;
        } catch (_) {}
      }
      break;
    }
    return current;
  }

  function normalizeGrammarResponse(raw) {
    const original = String(raw || '').trim();
    if (!original) throw new Error('Instant AI вернул пустой ответ');
    if (looksLikeVendorError(original)) {
      throw Object.assign(new Error('Instant AI: временная ошибка Premium Chat'), { code: 'instant_chat_vendor_error' });
    }

    let parsed = null;
    try { parsed = JSON.parse(stripCodeFence(original)); } catch (_) {}
    parsed = unwrapGrammarObject(parsed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('Instant AI вернул неполный разбор'), { code: 'instant_chat_incomplete' });
    }

    const parts = Array.isArray(parsed.parts) ? parsed.parts.slice(0, 5).map(p => ({
      text: String(p?.text || p?.zh || p?.ja || p?.en || p?.fr || '').trim(),
      pinyin: String(p?.pinyin || '').trim(),
      reading: String(p?.reading || '').trim(),
      what: String(p?.what || p?.meaning || p?.role || '').trim(),
      why: String(p?.why || p?.grammar || p?.note || '').trim(),
    })).filter(p => p.text || p.what || p.why) : [];

    const whys = Array.isArray(parsed.whys) ? parsed.whys.slice(0, 2).map(w => ({
      q: String(w?.q || w?.question || '').trim(),
      a: String(w?.a || w?.answer || '').trim(),
    })).filter(w => w.q || w.a) : [];

    const summary = String(parsed.summary || parsed.explanation || parsed.ru || parsed.answer || '').trim();
    if (!parts.length && !whys.length && !summary) {
      throw Object.assign(new Error('Instant AI вернул пустой структурированный разбор'), { code: 'instant_chat_incomplete' });
    }
    return { parts, whys, summary };
  }

  function setSummaryLabel(details) {
    try {
      const label = details?.querySelector?.('summary span');
      if (label) label.textContent = 'скрыть';
    } catch (_) {}
  }

  function appendVisibleFallback(active, analysis) {
    if (!active || active.querySelector('.reader-sentence-analysis')) return false;
    try {
      const details = document.createElement('details');
      details.className = 'reader-help-block reader-sentence-analysis ra2-block reader-instant-chat-fallback';
      details.open = true;
      const summaryEl = document.createElement('summary');
      summaryEl.append(document.createTextNode('🧩 разбор '));
      const state = document.createElement('span');
      state.textContent = 'скрыть';
      summaryEl.appendChild(state);
      details.appendChild(summaryEl);

      const body = document.createElement('div');
      body.className = 'reader-help-body';
      for (const part of (analysis.parts || []).slice(0, 5)) {
        const row = document.createElement('div');
        row.className = 'ra2-part';
        const title = document.createElement('div');
        title.className = 'ra2-fr';
        title.textContent = String(part.text || '');
        row.appendChild(title);
        const reading = String(part.pinyin || part.reading || '').trim();
        if (reading) {
          const r = document.createElement('div');
          r.className = 'ra2-pinyin';
          r.textContent = reading;
          row.appendChild(r);
        }
        const what = String(part.what || '').trim();
        const why = String(part.why || '').trim();
        if (what || why) {
          const b = document.createElement('div');
          b.className = 'ra2-body';
          if (what) {
            const w = document.createElement('div');
            w.className = 'ra2-what';
            w.textContent = what;
            b.appendChild(w);
          }
          if (why) {
            const w = document.createElement('div');
            w.className = 'ra2-why';
            w.textContent = why;
            b.appendChild(w);
          }
          row.appendChild(b);
        }
        body.appendChild(row);
      }
      for (const why of (analysis.whys || []).slice(0, 2)) {
        const card = document.createElement('div');
        card.className = 'ra2-why-card';
        const q = document.createElement('div');
        q.className = 'ra2-why-q';
        q.textContent = String(why.q || '');
        const a = document.createElement('div');
        a.className = 'ra2-why-a';
        a.textContent = String(why.a || '');
        card.append(q, a);
        body.appendChild(card);
      }
      if (analysis.summary) {
        const summary = document.createElement('div');
        summary.className = 'ra2-summary';
        summary.textContent = String(analysis.summary);
        body.appendChild(summary);
      }
      details.appendChild(body);
      const text = active.querySelector('.reader-paragraph-text');
      if (text?.parentNode) text.insertAdjacentElement('afterend', details);
      else active.appendChild(details);
      return true;
    } catch (_) {
      return false;
    }
  }

  function revealGrammarAnalysis(analysis, attempt = 0) {
    try {
      const active = document.querySelector('#reader-chapter-text .reader-paragraph.active');
      const details = active?.querySelector?.('.reader-sentence-analysis');
      if (details) {
        details.open = true;
        setSummaryLabel(details);
        try { details.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
        return;
      }
      if (attempt >= 20) {
        if (appendVisibleFallback(active, analysis)) {
          try {
            active?.querySelector?.('.reader-sentence-analysis')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
          } catch (_) {}
        }
        return;
      }
    } catch (_) {}
    setTimeout(() => revealGrammarAnalysis(analysis, attempt + 1), 90);
  }

  window.__readerInstantChatResolve = (requestId, ok, payloadJson) => {
    const key = String(requestId || '');
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimeout(entry.timer);
    let payload = {};
    try { payload = JSON.parse(String(payloadJson || '{}')); } catch (_) {}
    if (ok) entry.resolve(payload);
    else entry.reject(Object.assign(new Error(payload.message || 'Instant AI Chat не сработал'), {
      code: payload.code || 'instant_chat',
    }));
  };

  function nativeAnalyze(payload) {
    return new Promise((resolve, reject) => {
      if (pending.size) {
        reject(Object.assign(new Error('Предыдущий запрос Instant AI ещё выполняется'), {
          code: 'instant_chat_busy',
        }));
        return;
      }
      const requestId = `chat-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        try { nativeBridge.cancel?.(requestId); } catch (_) {}
        reject(Object.assign(new Error('Instant AI Chat не вернул ответ за 50 секунд'), {
          code: 'instant_chat_timeout',
        }));
      }, 50000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        nativeBridge.analyze(requestId, JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  function retryableChatError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || error || '');
    return code === 'instant_chat_vendor_error' || looksLikeVendorError(message);
  }

  async function runGrammarRequest(payload) {
    const requestPayload = {
      text: String(payload.text || ''),
      sourceLang: String(payload.sourceLang || payload.lang || ''),
      prompt: buildGrammarPrompt(payload),
    };

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await nativeAnalyze(requestPayload);
        const raw = String(result?.text || '').trim();
        const analysis = normalizeGrammarResponse(raw);
        analysis.provider = 'instant_translate_chat_ui';
        return analysis;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && retryableChatError(error)) {
          await new Promise(resolve => setTimeout(resolve, 260));
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('Instant AI Chat не сработал');
  }

  window.fetch = async function readerInstantChatFetch(input, init = undefined) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
    if (method !== 'POST' || !isReaderAiCallable(url) || typeof init?.body !== 'string') {
      return originalFetch(input, init);
    }

    let callableBody;
    try { callableBody = JSON.parse(init.body); } catch (_) { return originalFetch(input, init); }
    const payload = callableBody?.data;
    if (!payload || payload.task !== 'analyze_sentence' || !String(payload.text || '').trim()) {
      return originalFetch(input, init);
    }

    relabelLegacyGrammarToast();
    setTimeout(relabelLegacyGrammarToast, 50);
    setTimeout(relabelLegacyGrammarToast, 160);

    try {
      const analysis = await runGrammarRequest(payload);
      window.__readerInstantLastGrammarAnalysis = analysis;
      setTimeout(() => revealGrammarAnalysis(analysis, 0), 120);
      return new Response(JSON.stringify({ data: analysis, result: analysis }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      const reason = String(error?.message || error || 'неизвестная ошибка').slice(0, 240);
      console.warn('[Instant AI Chat]', error?.code || '', reason);
      showChatError(reason);
      return new Response(JSON.stringify({
        error: { message: reason, code: error?.code || 'instant_chat' },
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  };

  window.__readerInstantChatBridgeInstalled = true;
  console.info('[Instant AI Chat] compact grammar bridge active');
})();

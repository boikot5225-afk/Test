// Offline Chinese word-card glue.
//
// word-lookup.js can temporarily put `EN: ...` into the transient `ru` field
// purely to tell the legacy reader-app caller that the local lookup is complete
// and must NOT auto-call DeepSeek. The visible card may show that English
// fallback, but the editable "перевод по-русски" input must stay empty so an
// English definition can never be saved as Russian by accident.

function protectOfflineChineseRuField(event) {
  const detail = event?.detail || {};
  if (detail.lang !== 'zh' || detail.source !== 'offline-cedict-en') return;
  queueMicrotask(() => {
    const panel = document.getElementById('reader-word-panel');
    if (!panel?.classList?.contains('open')) return;
    const ru = panel.querySelector('#reader-word-ru');
    if (ru && /^EN:\s*/i.test(String(ru.value || ''))) ru.value = '';
    const status = panel.querySelector('#reader-word-status');
    if (status) {
      status.style.display = 'block';
      status.style.color = 'var(--text-muted)';
      status.textContent = '📚 CC-CEDICT офлайн · показано английское словарное значение';
    }
  });
}

document.addEventListener('reader-word-analysis-ready', protectOfflineChineseRuField);

from pathlib import Path

p = Path('js/reader/vocab-estimate.js')
t = p.read_text('utf-8')
start = t.index('function scheduleRefresh() {')
end = t.index('installVocabularyEstimate();', start)
replacement = r'''function queueWordNode(node) {
  if (!(node instanceof Element)) return;
  if (node.classList.contains('reader-word')) pendingWordNodes.add(node);
  node.querySelectorAll?.('.reader-word').forEach(word => pendingWordNodes.add(word));
}

function flushPendingWordNodes() {
  pendingBatchScheduled = false;
  if (pendingWordNodes.size) {
    const batch = Array.from(pendingWordNodes);
    pendingWordNodes.clear();
    applyClassificationBatch(batch);
  }
  ensureVocabularyButton();
}

function schedulePendingWordBatch() {
  if (pendingBatchScheduled) return;
  pendingBatchScheduled = true;
  requestAnimationFrame(flushPendingWordNodes);
}

function installRenderObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) { setTimeout(installRenderObserver, 250); return; }
  if (renderObserver && renderObserverRoot === root) return;
  renderObserver?.disconnect();
  renderObserverRoot = root;
  renderObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes || []) queueWordNode(node);
    }
    if (pendingWordNodes.size) schedulePendingWordBatch();
  });
  renderObserver.observe(root, { childList: true, subtree: true });
  root.querySelectorAll('.reader-word').forEach(word => pendingWordNodes.add(word));
  schedulePendingWordBatch();
}

function ensureVocabularyButton() {
  const top = document.querySelector('#reader-reading-view .rd-top');
  if (!top) return null;
  let button = document.getElementById('reader-vocab-btn');
  if (!button) {
    button = document.createElement('button');
    button.id = 'reader-vocab-btn';
    button.type = 'button';
    button.className = 'rd-icon rd-vocab-btn';
    button.textContent = '词';
    button.title = 'Словарь · Measure my level';
    button.setAttribute('aria-label', 'Словарь и оценка уровня');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openVocabularyDashboard();
    });
    const pinyin = document.getElementById('reader-pinyin-btn');
    if (pinyin?.parentNode === top) top.insertBefore(button, pinyin);
    else top.appendChild(button);
  }
  toolbarButton = button;
  button.style.display = currentLang() === 'zh' ? '' : 'none';
  return button;
}

function installPanelHook() {
  if (document.documentElement?.dataset?.readerVocabPanelHook === '1') return;
  if (document.documentElement) document.documentElement.dataset.readerVocabPanelHook = '1';
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.('#reader-chapter-text .reader-word')) return;
    queueMicrotask(() => { decorateWordPanel(); syncPanelKnowledge(); });
    setTimeout(() => { decorateWordPanel(); syncPanelKnowledge(); }, 40);
  }, true);
}

function warmFrequencyWhenUseful() {
  if (!loadProfile()) return;
  const run = () => loadFrequencyData()
    .then(() => applyEstimateToRenderedWords())
    .catch(error => console.warn('[reader vocab] unable to warm Mandarin list', error?.message || error));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 900 });
  else setTimeout(run, 250);
}

function bootVocabularyUi() {
  ensureVocabularyButton();
  installPanelHook();
  installRenderObserver();
  decorateWordPanel();
  warmFrequencyWhenUseful();
}

export function installVocabularyEstimate() {
  if (globalThis.__readerVocabularyEstimateVersion === 7) return;
  globalThis.__readerVocabularyEstimateVersion = 7;
  installStyles();

  globalThis.readerOpenVocabularyEstimate = openVocabularyDashboard;
  globalThis.readerStartVocabularyEstimate = openVocabularyEstimate;
  globalThis.readerCloseVocabularyEstimate = closeVocabularyEstimate;
  globalThis.readerApplyVocabularyEstimate = applyEstimateToRenderedWords;
  globalThis.readerMigakuMarkKnown = () => markCurrentWord(true);
  globalThis.readerMigakuMarkUnknown = () => markCurrentWord(false);
  globalThis.readerVocabularyEstimateProfile = loadProfile;
  globalThis.readerVocabularyKnowledgeFor = (word, lang = 'zh') => classificationFor(word, lang);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootVocabularyUi, { once: true });
  } else {
    bootVocabularyUi();
  }
  window.addEventListener('pageshow', bootVocabularyUi);
}

'''
t = t[:start] + replacement + t[end:]

# There must be no forced layout reads or the old observer architecture left.
for forbidden in ['getBoundingClientRect', 'getComputedStyle', 'readerVocabSyntheticKnown', 'installGlossObserver', 'document.documentElement || document.body']:
    assert forbidden not in t, forbidden

p.write_text(t, 'utf-8')

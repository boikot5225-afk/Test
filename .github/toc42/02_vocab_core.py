from pathlib import Path

p = Path('js/reader/vocab-estimate.js')
t = p.read_text('utf-8')

old = """let frequencyPromise = null;
let frequencyData = null;
let assessment = null;
let refreshScheduled = false;
let observer = null;
let glossObserver = null;
let measureCanvas = null;
"""
new = """let frequencyPromise = null;
let frequencyData = null;
let assessment = null;
let renderObserver = null;
let renderObserverRoot = null;
let pendingWordNodes = new Set();
let pendingBatchScheduled = false;
let toolbarButton = null;
"""
assert old in t
t = t.replace(old, new, 1)

start = t.index('function measureContext() {')
end = t.index('function applyClassificationToElement', start)
core = """function manualKnowledgeMapSnapshot(store = wordStateStore()) {
  const map = new Map();
  for (const state of Object.values(store || {})) {
    if (!state || canonicalLang(state.lang) !== 'zh') continue;
    const explicit = manualKnowledge(state);
    const word = normalizeWord(state.word, 'zh');
    if (explicit && word) map.set(word, explicit);
  }
  return map;
}

function classificationForSnapshot(word, profile, manualMap) {
  const normalized = normalizeWord(word, 'zh');
  if (!normalized) return { value: '', source: '', index: null, rank: null };
  const manual = manualMap?.get(normalized) || '';
  const index = frequencyData?.rank?.get(normalized);
  const rank = Number.isInteger(index) ? index + 1 : null;
  if (manual) return { value: manual, source: 'manual', index, rank };
  if (!profile) return { value: '', source: '', index, rank };
  if (!frequencyData) return { value: '', source: 'pending', index: null, rank: null };
  if (!Number.isInteger(index)) return { value: 'unknown', source: 'unranked', index: null, rank: null, ...profile };
  return {
    value: index < profile.conservativeKnownCount ? 'known' : 'unknown',
    source: 'assessment', index, rank,
    estimate: profile.estimate,
    conservativeKnownCount: profile.conservativeKnownCount,
  };
}

function removeKnowledgeClasses(el) {
  el.classList.remove('rw-migaku-known', 'rw-migaku-unknown');
  delete el.dataset.readerEstimatedKnowledge;
  delete el.dataset.readerManualKnowledge;
}

"""
t = t[:start] + core + t[end:]

start = t.index('function applyClassificationToElement')
end = t.index('function profileButtonText', start)
apply = """function applyClassificationToElement(el, classification) {
  removeKnowledgeClasses(el);
  if (classification?.value === 'known') {
    el.classList.add('rw-migaku-known');
  } else if (classification?.value === 'unknown') {
    // Only explicit Unknown may clear an old legacy Known marker. Automatic
    // Known never creates rw-known, so the stable Chinese gloss DOM is intact.
    el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else {
    return;
  }

  if (classification.source === 'manual') el.dataset.readerManualKnowledge = classification.value;
  else el.dataset.readerEstimatedKnowledge = classification.value;

  const rankText = Number.isInteger(classification.rank) ? ` · частотность #${formatNumber(classification.rank)}` : '';
  if (classification.source === 'manual') {
    el.title = `${classification.value === 'known' ? 'Знаю' : 'Не знаю'} · вручную${rankText}`;
  } else if (classification.source === 'assessment') {
    el.title = `${classification.value === 'known' ? 'Known' : 'Unknown'} · оценка ≈ ${formatNumber(classification.estimate)}${rankText}`;
  } else if (classification.source === 'unranked') {
    el.title = 'Unknown · слова нет в частотном списке';
  }
}

function applyClassificationBatch(elements) {
  const list = Array.from(elements || []);
  if (!list.length) return;
  const profile = loadProfile();
  const manualMap = manualKnowledgeMapSnapshot();
  for (const el of list) {
    if (!el?.classList?.contains('reader-word')) continue;
    const lang = canonicalLang(el.dataset.lang || currentLang());
    if (lang !== 'zh') {
      removeKnowledgeClasses(el);
      continue;
    }
    const word = el.dataset.word || el.textContent || '';
    applyClassificationToElement(el, classificationForSnapshot(word, profile, manualMap));
  }
}

async function applyEstimateToRenderedWords() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const profile = loadProfile();
  if (profile && !frequencyData) {
    try { await loadFrequencyData(); }
    catch (error) { console.warn('[reader vocab] frequency data unavailable', error?.message || error); }
  }
  applyClassificationBatch(root.querySelectorAll('.reader-word[data-word]'));
  decorateWordPanel();
  syncPanelKnowledge();
  ensureVocabularyButton();
}

"""
t = t[:start] + apply + t[end:]

# Word-card entry should open the dashboard rather than hiding the feature there.
old = "block.querySelector('#reader-vocab-estimate-btn')?.addEventListener('click', () => openVocabularyEstimate());"
assert old in t
t = t.replace(old, "block.querySelector('#reader-vocab-estimate-btn')?.addEventListener('click', () => openVocabularyDashboard());", 1)

p.write_text(t, 'utf-8')

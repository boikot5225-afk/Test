import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

// English Migaku-style vocabulary layer. It is intentionally separate from the
// Mandarin layer so the frozen toc47 Chinese renderer/classifier remains untouched.
// Data comes from Migaku's own English assessment list (hen) and morphology core.

const PROFILE_BASE_KEY = 'an2_reader_vocab_estimate_en_v1';
const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const OWNER_KEY = 'an2_reader_active_owner_v1';
const FREQ_URL = 'data/en_vocab_frequency.tsv?v=1';
const LEMMA_URL = 'data/en_vocab_lemma.tsv?v=1';
const MODAL_ID = 'reader-vocab-estimate-modal';
const WORDS_PER_PAGE = 14;
const STEP1_COUNT = 42;
const STEP2_COUNT = 42;
const EXPECTED_COUNT = 36566;

let dataPromise = null;
let englishData = null;
let assessment = null;
let renderObserver = null;
let renderObserverRoot = null;
let pendingWordNodes = new Set();
let pendingBatchScheduled = false;

function canonicalLang(value) {
  const lang = String(value || '').toLowerCase();
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('zh') || lang === 'cn') return 'zh';
  if (lang.startsWith('ja') || lang === 'jp') return 'ja';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('es')) return 'es';
  return lang || 'en';
}

function currentLang() {
  return canonicalLang(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  );
}

function ownerId() {
  try {
    const stored = localStorage.getItem(OWNER_KEY);
    if (stored) return stored;
    if (localStorage.getItem('an2_guest') === '1') return 'guest';
  } catch {}
  return 'anon';
}

function scopedKey(base) { return `${base}::${ownerId()}`; }

function formatNumber(value) {
  try { return Math.round(Number(value || 0)).toLocaleString('ru-RU'); }
  catch { return String(Math.round(Number(value || 0))); }
}

function normalizeSurface(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .trim()
    .toLocaleLowerCase('en-US');
}

function wordStateStore() {
  try {
    const live = globalThis.an2ReaderWordStateSnapshot?.();
    if (live && typeof live === 'object') return live;
  } catch {}
  try { return JSON.parse(localStorage.getItem(scopedKey(WORD_STATE_BASE_KEY)) || '{}') || {}; }
  catch { return {}; }
}

function persistWordState(store) {
  const key = scopedKey(WORD_STATE_BASE_KEY);
  try { localStorage.setItem(key, JSON.stringify(store || {})); } catch {}
  wordStateIdbPut(key, store || {}).catch(error => {
    console.warn('[reader en vocab] IndexedDB save failed', error?.message || error);
  });
}

function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(PROFILE_BASE_KEY)) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const estimate = Math.max(0, Math.round(Number(raw.estimate || 0)));
    const conservativeKnownCount = Math.max(0, Math.round(Number(
      raw.conservativeKnownCount ?? conservativeCountForEstimate(estimate, EXPECTED_COUNT),
    )));
    return { ...raw, language: 'en', estimate, conservativeKnownCount };
  } catch { return null; }
}

function saveProfile(profile) {
  const estimate = Math.max(0, Math.round(Number(profile?.estimate || 0)));
  const listLength = Math.max(0, Number(profile?.listLength || englishData?.entries?.length || EXPECTED_COUNT));
  const next = {
    language: 'en',
    version: 1,
    ...profile,
    estimate,
    conservativeKnownCount: Math.max(0, Math.round(Number(
      profile?.conservativeKnownCount ?? conservativeCountForEstimate(estimate, listLength),
    ))),
    updatedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(scopedKey(PROFILE_BASE_KEY), JSON.stringify(next)); } catch {}
  return next;
}

function buildEnglishData(freqText, lemmaText) {
  const entries = [];
  const rankExact = new Map();
  const rankFold = new Map();
  for (const rawLine of String(freqText || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const tab = rawLine.indexOf('\t');
    const word = (tab >= 0 ? rawLine.slice(0, tab) : rawLine).trim();
    const pos = tab >= 0 ? rawLine.slice(tab + 1).trim() : '';
    if (!word) continue;
    const index = entries.length;
    entries.push({ word, pos });
    if (!rankExact.has(word)) rankExact.set(word, index);
    const folded = normalizeSurface(word);
    if (!rankFold.has(folded)) rankFold.set(folded, { index, word });
  }

  const lemma = new Map();
  for (const rawLine of String(lemmaText || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const tab = rawLine.indexOf('\t');
    if (tab <= 0) continue;
    const surface = normalizeSurface(rawLine.slice(0, tab));
    const target = rawLine.slice(tab + 1).trim();
    if (surface && target) lemma.set(surface, target);
  }
  return { entries, rankExact, rankFold, lemma };
}

async function loadEnglishData() {
  if (englishData) return englishData;
  if (dataPromise) return dataPromise;
  dataPromise = Promise.all([
    fetch(new URL(FREQ_URL, document.baseURI), { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`${FREQ_URL}: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(new URL(LEMMA_URL, document.baseURI), { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`${LEMMA_URL}: HTTP ${r.status}`);
      return r.text();
    }),
  ]).then(([freqText, lemmaText]) => {
    const data = buildEnglishData(freqText, lemmaText);
    if (data.entries.length !== EXPECTED_COUNT) {
      throw new Error(`English frequency list length ${data.entries.length}, expected ${EXPECTED_COUNT}`);
    }
    if (data.rankExact.size !== EXPECTED_COUNT) {
      throw new Error(`English frequency list has ${EXPECTED_COUNT - data.rankExact.size} duplicate entries`);
    }
    const sentinels = [[0,'I'],[1,'be'],[2,'you'],[3,'the'],[4,'to'],[17,'go'],[99,'win'],[999,'complete'],[4999,'microwave'],[9999,'uno'],[19999,'commonality'],[29999,'bannister'],[36565,'unbend']];
    for (const [index, expected] of sentinels) {
      if (data.entries[index]?.word !== expected) {
        throw new Error(`English frequency mismatch at #${index + 1}: ${data.entries[index]?.word || '∅'} != ${expected}`);
      }
    }
    const lemmaSentinels = { went:'go', gone:'go', going:'go', goes:'go', am:'be', is:'be', was:'be', were:'be', aimed:'aim' };
    for (const [surface, expected] of Object.entries(lemmaSentinels)) {
      if (data.lemma.get(surface) !== expected) {
        throw new Error(`English lemma mismatch: ${surface} -> ${data.lemma.get(surface) || '∅'} != ${expected}`);
      }
    }
    englishData = data;
    try { window.dispatchEvent(new CustomEvent('reader:en-vocab-ready')); } catch {}
    return data;
  }).finally(() => { dataPromise = null; });
  return dataPromise;
}

function lemmaForWordSync(word) {
  const raw = String(word || '').trim();
  const folded = normalizeSurface(raw);
  if (!folded) return '';
  if (!englishData) return folded;
  const mapped = englishData.lemma.get(folded);
  if (mapped) return mapped;
  const exact = englishData.rankExact.get(raw);
  if (Number.isInteger(exact)) return englishData.entries[exact]?.word || raw;
  const fallback = englishData.rankFold.get(folded);
  return fallback?.word || folded;
}

function rankIndexForWordSync(word) {
  if (!englishData) return null;
  const lemma = lemmaForWordSync(word);
  const exact = englishData.rankExact.get(lemma);
  if (Number.isInteger(exact)) return exact;
  const folded = englishData.rankFold.get(normalizeSurface(lemma));
  return Number.isInteger(folded?.index) ? folded.index : null;
}

function manualKnowledge(state) {
  const explicit = String(state?.manualKnowledge || '').toLowerCase();
  if (explicit === 'known' || explicit === 'unknown') return explicit;
  const status = String(state?.status || '').trim().toLowerCase();
  // Core Reader manual Known predates manualKnowledge. autoKnown=false is the
  // discriminator: automatic/common words must not become sticky overrides.
  if (state?.known === true && status === 'known' && state?.autoKnown === false) return 'known';
  // Preserve the old explicit Problem/Hard user decision as manual Unknown.
  if (state?.known === false && state?.saved === true && (status === 'problem' || status === 'hard')) return 'unknown';
  return '';
}

function directStateKey(word) { return `en:${normalizeSurface(word)}`; }

function findWordState(word, create = false) {
  const raw = String(word || '').trim();
  const canonical = lemmaForWordSync(raw) || normalizeSurface(raw);
  const store = wordStateStore();
  if (!canonical) return { store, key: '', state: null, canonical: '' };
  const key = directStateKey(canonical);
  if (store[key]) return { store, key, state: store[key], canonical };

  const rawKey = directStateKey(raw);
  if (store[rawKey]) return { store, key: rawKey, state: store[rawKey], canonical };
  for (const [candidateKey, state] of Object.entries(store)) {
    if (!state || canonicalLang(state.lang) !== 'en') continue;
    if (lemmaForWordSync(state.word) === canonical) return { store, key: candidateKey, state, canonical };
  }

  if (!create) return { store, key, state: null, canonical };
  store[key] = {
    word: canonical,
    lang: 'en',
    seen: 0,
    clicked: 0,
    saved: false,
    known: false,
    status: 'new',
    places: {},
    clickContexts: {},
    updatedAt: new Date().toISOString(),
  };
  return { store, key, state: store[key], canonical };
}

function manualKnowledgeMapSnapshot(store = wordStateStore()) {
  const latest = new Map();
  for (const state of Object.values(store || {})) {
    if (!state || canonicalLang(state.lang) !== 'en') continue;
    const explicit = manualKnowledge(state);
    if (!explicit) continue;
    const canonical = lemmaForWordSync(state.word);
    if (!canonical) continue;
    const stamp = Date.parse(state.updatedAt || '') || 0;
    const prev = latest.get(canonical);
    if (!prev || stamp >= prev.stamp) latest.set(canonical, { value: explicit, stamp });
  }
  return new Map(Array.from(latest, ([word, info]) => [word, info.value]));
}

function conservativeCountForEstimate(estimate, listLength) {
  const value = Number(estimate || 0);
  const count = value < 20000
    ? Math.round((value * 0.6) / 10) * 10
    : 10000;
  return Math.max(0, Math.min(10000, Math.min(Math.round(count), Math.max(0, Number(listLength || 0)))));
}

function classificationForSnapshot(word, profile, manualMap) {
  const canonical = lemmaForWordSync(word);
  if (!canonical) return { value:'', source:'', lemma:'', index:null, rank:null };
  const manual = manualMap?.get(canonical) || '';
  const index = rankIndexForWordSync(canonical);
  const rank = Number.isInteger(index) ? index + 1 : null;
  if (manual) return { value:manual, source:'manual', lemma:canonical, index, rank };
  if (!profile) return { value:'', source:'', lemma:canonical, index, rank };
  if (!englishData) return { value:'', source:'pending', lemma:canonical, index:null, rank:null };
  if (!Number.isInteger(index)) return { value:'unknown', source:'unranked', lemma:canonical, index:null, rank:null, ...profile };
  return {
    value: index < profile.conservativeKnownCount ? 'known' : 'unknown',
    source:'assessment', lemma:canonical, index, rank,
    estimate:profile.estimate,
    conservativeKnownCount:profile.conservativeKnownCount,
  };
}

function classificationFor(word) {
  const { state } = findWordState(word, false);
  const explicit = manualKnowledge(state);
  const canonical = lemmaForWordSync(word);
  const index = rankIndexForWordSync(canonical);
  const rank = Number.isInteger(index) ? index + 1 : null;
  if (explicit) return { value:explicit, source:'manual', state, lemma:canonical, index, rank };
  return classificationForSnapshot(word, loadProfile(), manualKnowledgeMapSnapshot());
}

function removeKnowledgeClasses(el) {
  el.classList.remove('rw-migaku-known', 'rw-migaku-unknown');
  delete el.dataset.readerEstimatedKnowledge;
  delete el.dataset.readerManualKnowledge;
}

function applyClassificationToElement(el, info) {
  removeKnowledgeClasses(el);
  if (info?.value === 'known') el.classList.add('rw-migaku-known');
  else if (info?.value === 'unknown') {
    // Same hard rule as Chinese: assessment/unranked classification cannot
    // revoke a core manual Known marker.  Only the user's explicit Unknown can.
    if (info.source !== 'manual' && el.classList.contains('rw-known')) {
      el.classList.add('rw-migaku-known');
      return;
    }
    if (info.source === 'manual') el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else return;
  if (info.source === 'manual') el.dataset.readerManualKnowledge = info.value;
  else el.dataset.readerEstimatedKnowledge = info.value;
  const lemmaText = info.lemma && normalizeSurface(el.dataset.word || '') !== normalizeSurface(info.lemma)
    ? ` · ${info.lemma}` : '';
  const rankText = Number.isInteger(info.rank) ? ` · частотность #${formatNumber(info.rank)}` : '';
  el.title = `${info.value === 'known' ? 'Known' : 'Unknown'}${lemmaText}${rankText}`;
}

function applyClassificationBatch(elements) {
  const list = Array.from(elements || []);
  if (!list.length || currentLang() !== 'en') return;
  const profile = loadProfile();
  const manualMap = manualKnowledgeMapSnapshot();
  for (const el of list) {
    if (!el?.classList?.contains('reader-word')) continue;
    if (canonicalLang(el.dataset.lang || currentLang()) !== 'en') continue;
    applyClassificationToElement(el, classificationForSnapshot(el.dataset.word || el.textContent || '', profile, manualMap));
  }
}

async function applyEstimateToRenderedWords() {
  if (currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  try { await loadEnglishData(); }
  catch (error) { console.warn('[reader en vocab] data unavailable', error?.message || error); return; }
  applyClassificationBatch(root.querySelectorAll('.reader-word[data-word]'));
  decorateWordPanel();
  syncPanelKnowledge();
  ensureVocabularyButton();
}

function currentPanelWord() {
  return String(document.getElementById('reader-word-title')?.textContent || '').trim();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.style.display = 'none'; }, 1700);
}

function profileButtonText() {
  const profile = loadProfile();
  return profile ? `≈ ${formatNumber(profile.estimate)} слов · переоценить` : '≈ Оценить словарный запас';
}

function syncPanelKnowledge() {
  if (currentLang() !== 'en') return;
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const yes = panel.querySelector('#reader-en-migaku-known-btn');
  const no = panel.querySelector('#reader-en-migaku-unknown-btn');
  const source = panel.querySelector('#reader-en-migaku-source');
  const estimateButton = panel.querySelector('#reader-en-vocab-estimate-btn');
  if (estimateButton) estimateButton.textContent = profileButtonText();
  if (!yes || !no || !source) return;
  yes.classList.remove('is-active'); no.classList.remove('is-active');
  const word = currentPanelWord();
  if (!word || word === '—') { source.textContent=''; return; }
  const info = classificationFor(word);
  if (info.value === 'known') yes.classList.add('is-active');
  if (info.value === 'unknown') no.classList.add('is-active');
  const lemmaText = info.lemma && normalizeSurface(word) !== normalizeSurface(info.lemma) ? ` · лемма ${info.lemma}` : '';
  const rankText = Number.isInteger(info.rank) ? ` · частотность #${formatNumber(info.rank)}` : '';
  if (info.source === 'manual') source.textContent = `${info.value === 'known' ? 'Знаю' : 'Не знаю'} · вручную${lemmaText}${rankText}`;
  else if (info.source === 'assessment') source.textContent = info.value === 'known'
    ? `По тесту: Known · базовые ${formatNumber(info.conservativeKnownCount)} из ≈ ${formatNumber(info.estimate)}${lemmaText}${rankText}`
    : `По тесту: Unknown · оценка ≈ ${formatNumber(info.estimate)}${lemmaText}${rankText}`;
  else if (info.source === 'unranked') source.textContent = `Нет в частотном списке · считаю Unknown${lemmaText}`;
  else source.textContent = `Пройди оценку словаря или задай статус вручную${lemmaText}${rankText}`;
}

function decorateWordPanel() {
  if (currentLang() !== 'en') return;
  const panel = document.getElementById('reader-word-panel');
  const actions = panel?.querySelector('.reader-word-actions');
  if (!panel || !actions) return;
  if (panel.dataset.migakuKnowledge !== 'en1') {
    panel.dataset.migakuKnowledge = 'en1';
    panel.querySelector('.rwp-migaku-knowledge')?.remove();
    for (const button of actions.querySelectorAll('button')) {
      const onclick = button.getAttribute('onclick') || '';
      if (onclick.includes('readerMarkSelectedWordKnown') || onclick.includes('readerMarkSelectedWordProblem')) {
        button.style.display='none'; button.setAttribute('aria-hidden','true');
      }
    }
    const block=document.createElement('div');
    block.className='rwp-migaku-knowledge';
    block.innerHTML=`
      <div class="rwp-migaku-row">
        <button id="reader-en-migaku-unknown-btn" class="rwp-migaku-btn rwp-migaku-unknown" type="button">Не знаю</button>
        <button id="reader-en-migaku-known-btn" class="rwp-migaku-btn rwp-migaku-known" type="button">Знаю</button>
      </div>
      <div id="reader-en-migaku-source" class="rwp-migaku-source"></div>
      <button id="reader-en-vocab-estimate-btn" class="rwp-vocab-estimate-btn" type="button"></button>`;
    actions.before(block);
    block.querySelector('#reader-en-migaku-known-btn')?.addEventListener('click',()=>markCurrentWord(true));
    block.querySelector('#reader-en-migaku-unknown-btn')?.addEventListener('click',()=>markCurrentWord(false));
    block.querySelector('#reader-en-vocab-estimate-btn')?.addEventListener('click',()=>openVocabularyDashboard());
  }
  syncPanelKnowledge();
}

async function markCurrentWord(known) {
  if (currentLang() !== 'en') return;
  const word=currentPanelWord();
  if (!word || word==='—') return;
  try { await loadEnglishData(); } catch {}
  const found=findWordState(word,true);
  const state=found.state;
  if (!state) return;
  state.word=found.canonical || state.word || word;
  state.lang='en';
  state.manualKnowledge=known?'known':'unknown';
  state.known=!!known;
  state.autoKnown=false;
  state.status=known?'known':'learning';
  state.updatedAt=new Date().toISOString();
  persistWordState(found.store);
  const root=document.getElementById('reader-chapter-text');
  root?.querySelectorAll('.reader-word[data-lang="en"]').forEach(el=>{
    if (lemmaForWordSync(el.dataset.word || '') !== found.canonical) return;
    applyClassificationToElement(el, classificationFor(el.dataset.word || ''));
  });
  syncPanelKnowledge();
  try { window.dispatchEvent(new CustomEvent('reader:en-vocab-ready')); } catch {}
  showToast(known?'✓ Знаю':'Не знаю');
}

function randomNormal(mean,stdDev) {
  const u=Math.random() || Number.MIN_VALUE;
  const v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)*stdDev+mean;
}
function selectStep1Indices(length,count) {
  const picked=[]; const target=Math.min(count,length);
  while (picked.length<target) {
    const index=Math.floor(Math.pow(Math.random(),2)*length);
    if (!picked.includes(index)) picked.push(index);
  }
  return picked;
}
function selectStep2Indices(length,estimate,count) {
  let center=Number(estimate||0); if (center<100) center=100;
  const picked=[]; const target=Math.min(count,length); let guard=0;
  while (picked.length<target && guard<100000) {
    guard+=1;
    const index=Math.floor(randomNormal(center,center*.35));
    if (index<0 || index>=length || picked.includes(index)) continue;
    picked.push(index);
  }
  for (let i=0;picked.length<target && i<length;i+=1) if (!picked.includes(i)) picked.push(i);
  return picked;
}
function estimateFromChecks(checks,indices) {
  if (!Array.isArray(checks)||!checks.length||!Array.isArray(indices)||!indices.length) return 0;
  const unknownPrefix=[0];
  for (let i=0;i<checks.length;i+=1) unknownPrefix.push(unknownPrefix[i]+(checks[i]?0:1));
  const knownSuffix=new Array(checks.length+1).fill(0);
  for (let i=checks.length-1;i>=0;i-=1) knownSuffix[i]=knownSuffix[i+1]+(checks[i]?1:0);
  let boundary=0;
  for (let i=0;i<indices.length+1;i+=1) if (unknownPrefix[i]===knownSuffix[i]) { boundary=i; break; }
  if (boundary>=indices.length) boundary=indices.length-1;
  if (boundary<0) boundary=0;
  return boundary===0 ? .5*indices[boundary] : .5*(indices[boundary]+indices[boundary-1]);
}
function checksFor(indices,knownSet) { return indices.map(index=>knownSet.has(index)); }

function ensureModal() {
  let modal=document.getElementById(MODAL_ID);
  if (modal) return modal;
  modal=document.createElement('div'); modal.id=MODAL_ID;
  modal.addEventListener('click',event=>{ if (event.target===modal) closeVocabularyEstimate(); });
  document.body.appendChild(modal); return modal;
}
function modalShell(inner,{title='Оценка словарного запаса',back=false}={}) {
  return `<div class="rve-card">
    <div class="rve-head">
      ${back?'<button class="rve-back" type="button" aria-label="Назад">←</button>':'<span class="rve-head-spacer"></span>'}
      <div class="rve-title">${title}</div>
      <button class="rve-close" type="button" aria-label="Закрыть">×</button>
    </div>${inner}</div>`;
}
function bindModalChrome(modal,{back=null}={}) {
  modal.querySelector('.rve-close')?.addEventListener('click',closeVocabularyEstimate);
  if (back) modal.querySelector('.rve-back')?.addEventListener('click',back);
}

function currentVocabularyStats() {
  const root=document.getElementById('reader-chapter-text');
  const unique=new Set();
  root?.querySelectorAll('.reader-word[data-lang="en"][data-word]').forEach(el=>{
    const lemma=lemmaForWordSync(el.dataset.word||el.textContent||''); if (lemma) unique.add(lemma);
  });
  const profile=loadProfile(); const manualMap=manualKnowledgeMapSnapshot();
  let known=0,unknown=0,unclassified=0;
  for (const word of unique) {
    const info=classificationForSnapshot(word,profile,manualMap);
    if (info.value==='known') known+=1;
    else if (info.value==='unknown') unknown+=1;
    else unclassified+=1;
  }
  return {total:unique.size,known,unknown,unclassified};
}

async function openVocabularyDashboard() {
  if (currentLang() !== 'en') return;
  const modal=ensureModal();
  modal.innerHTML=modalShell('<div class="rve-copy">Загружаю английский словарь…</div>',{title:'English vocabulary'});
  bindModalChrome(modal);
  try { await loadEnglishData(); }
  catch (error) {
    modal.innerHTML=modalShell(`<div class="rve-copy">Не удалось загрузить данные: ${String(error?.message||error)}</div>`,{title:'English vocabulary'});
    bindModalChrome(modal); return;
  }
  const profile=loadProfile(); const stats=currentVocabularyStats();
  const knownPct=stats.total?Math.round(stats.known*100/stats.total):0;
  modal.innerHTML=modalShell(`
    <div class="rve-dashboard">
      <div class="rve-result-kicker">Measure my level</div>
      <div class="rve-number">${profile?`≈ ${formatNumber(profile.estimate)}`:'—'}</div>
      <div class="rve-result-label">${profile?'оценка английского словаря':'уровень ещё не измерен'}</div>
      ${profile?`<div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div>`:''}
      <div class="rve-stat-grid">
        <div><b>${stats.total}</b><span>уникальных лемм в главе</span></div>
        <div><b>${stats.known}</b><span>Known · ${knownPct}%</span></div>
        <div><b>${stats.unknown}</b><span>Unknown</span></div>
      </div>
      <div class="rve-rule">Формы объединяются по лемме: <b>went / gone / going / goes → go</b>, <b>am / is / was / were → be</b>. Ручное «Знаю / Не знаю» всегда важнее автоматической оценки.</div>
      <button class="rve-primary" type="button">${profile?'Пройти тест заново':'Оценить мой уровень'}</button>
    </div>`,{title:'English vocabulary'});
  bindModalChrome(modal);
  modal.querySelector('.rve-primary')?.addEventListener('click',()=>openVocabularyEstimate());
}

async function openVocabularyEstimate() {
  if (currentLang() !== 'en') return;
  const modal=ensureModal();
  modal.innerHTML=modalShell('<div class="rve-copy">Загружаю словарь…</div>',{title:'Measure my level'});
  bindModalChrome(modal);
  let data;
  try { data=await loadEnglishData(); }
  catch (error) {
    modal.innerHTML=modalShell(`<div class="rve-copy">Не удалось загрузить данные: ${String(error?.message||error)}</div>`,{title:'Measure my level'});
    bindModalChrome(modal); return;
  }
  const profile=loadProfile();
  const previous=profile?`<div class="rve-rule">Текущая оценка: <b>≈ ${formatNumber(profile.estimate)} слов</b>. Базовыми Known считаются ${formatNumber(profile.conservativeKnownCount)} самых частых. Ручные решения при повторном тесте не стираются.</div>`:'';
  modal.innerHTML=modalShell(`
    <div class="rve-welcome">
      <div class="rve-migachu">W</div>
      <div class="rve-copy rve-copy-center"><b>Короткий тест задаст стартовую оценку английских слов, которые ты уже знаешь.</b><br><br>На каждом экране 14 слов. Отмечай слово только если понимаешь его без подсказки.</div>
      ${previous}
      <div class="rve-rule">Оригинальная схема Migaku: 42 слова по всему списку, затем ещё 42 около найденной границы. Инфлекционные формы в чтении считаются по лемме.</div>
      <button class="rve-primary" type="button">Начать</button>
    </div>`,{title:'Measure my level'});
  bindModalChrome(modal);
  modal.querySelector('.rve-primary')?.addEventListener('click',()=>startAssessment(data));
}

function startAssessment(data=englishData) {
  assessment={phase:1,page:0,step1:selectStep1Indices(data.entries.length,STEP1_COUNT).sort((a,b)=>a-b),step2:[],known1:new Set(),known2:new Set(),preliminaryEstimate:0,startedAt:new Date().toISOString()};
  renderAssessmentPage();
}
function currentIndices(){return assessment?.phase===1?assessment.step1:assessment?.step2||[];}
function currentKnownSet(){return assessment?.phase===1?assessment.known1:assessment?.known2||new Set();}
function currentPageSlice(){const start=assessment.page*WORDS_PER_PAGE;return currentIndices().slice(start,start+WORDS_PER_PAGE);}
function difficultyNumber(){return (assessment?.phase===2?3:0)+Number(assessment?.page||0)+1;}
function renderAssessmentPage() {
  const modal=ensureModal(); if (!assessment||!englishData) return;
  const indices=currentPageSlice(),known=currentKnownSet();
  const selected=indices.filter(i=>known.has(i)).length;
  const chips=indices.map(index=>{
    const entry=englishData.entries[index]||{word:'',pos:''}; const active=known.has(index);
    return `<button class="rve-word-chip rve-word-chip-en${active?' is-known':''}" type="button" data-index="${index}" aria-pressed="${active?'true':'false'}"><span>${entry.word}</span><i></i></button>`;
  }).join('');
  modal.innerHTML=modalShell(`
    <div class="rve-assessment-head"><div class="rve-page-title">Какие слова ты знаешь?</div><div class="rve-page-desc">Отметь знакомые слова:</div></div>
    <div class="rve-word-grid">${chips}</div>
    <div class="rve-difficulty">Сложность ${difficultyNumber()}</div><div class="rve-wave" aria-hidden="true"></div>
    <div class="rve-known-count">${selected}/${indices.length} знаю</div>
    <button class="rve-primary rve-continue" type="button">Продолжить</button>`,{title:'',back:true});
  bindModalChrome(modal,{back:goAssessmentBack});
  modal.querySelectorAll('.rve-word-chip').forEach(button=>button.addEventListener('click',()=>toggleAssessmentWord(Number(button.dataset.index))));
  modal.querySelector('.rve-continue')?.addEventListener('click',continueAssessment);
}
function toggleAssessmentWord(index){if(!assessment||!Number.isInteger(index))return;const known=currentKnownSet();known.has(index)?known.delete(index):known.add(index);renderAssessmentPage();}
function goAssessmentBack(){if(!assessment){closeVocabularyEstimate();return;}if(assessment.page>0){assessment.page-=1;renderAssessmentPage();return;}if(assessment.phase===2){renderIntermediary();return;}openVocabularyEstimate();}
function continueAssessment(){if(!assessment)return;const pageCount=Math.ceil(currentIndices().length/WORDS_PER_PAGE);if(assessment.page<pageCount-1){assessment.page+=1;renderAssessmentPage();return;}if(assessment.phase===1){assessment.preliminaryEstimate=estimateFromChecks(checksFor(assessment.step1,assessment.known1),[...assessment.step1]);renderIntermediary();return;}finishAssessment();}
function renderIntermediary(){const modal=ensureModal();if(!assessment)return;modal.innerHTML=modalShell(`<div class="rve-intermediary"><div class="rve-migachu">✓</div><div class="rve-inter-title">Отлично!</div><div class="rve-copy rve-copy-center">Теперь ещё один короткий раунд — слова ближе к предполагаемому уровню.</div><button class="rve-primary" type="button">Продолжить</button></div>`,{title:'',back:true});bindModalChrome(modal,{back:()=>{assessment.phase=1;assessment.page=Math.max(0,Math.ceil(assessment.step1.length/WORDS_PER_PAGE)-1);renderAssessmentPage();}});modal.querySelector('.rve-primary')?.addEventListener('click',startAssessmentPhase2);}
function startAssessmentPhase2(){if(!assessment||!englishData)return;if(!assessment.step2.length)assessment.step2=selectStep2Indices(englishData.entries.length,assessment.preliminaryEstimate,STEP2_COUNT).sort((a,b)=>a-b);assessment.phase=2;assessment.page=0;renderAssessmentPage();}
function finishAssessment(){if(!assessment||!englishData)return;const estimate=Math.max(0,Math.round(estimateFromChecks(checksFor(assessment.step2,assessment.known2),[...assessment.step2])));const conservativeKnownCount=conservativeCountForEstimate(estimate,englishData.entries.length);const profile=saveProfile({estimate,conservativeKnownCount,listLength:englishData.entries.length,source:'Migaku English hen assessment list',assessedAt:new Date().toISOString(),step1Estimate:Math.round(assessment.preliminaryEstimate),step1:assessment.step1.map(index=>({index,word:englishData.entries[index]?.word,known:assessment.known1.has(index)})),step2:assessment.step2.map(index=>({index,word:englishData.entries[index]?.word,known:assessment.known2.has(index)}))});assessment=null;applyEstimateToRenderedWords().catch(()=>{});Promise.resolve(globalThis.readerSetEnUnknownGlossMode?.('unknown')).catch(()=>{});renderAssessmentResult(profile);}
function renderAssessmentResult(profile){const modal=ensureModal();modal.innerHTML=modalShell(`<div class="rve-result"><div class="rve-result-kicker">Оценка словарного запаса</div><div class="rve-number">≈ ${formatNumber(profile.estimate)}</div><div class="rve-result-label">английских слов</div><div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div><div class="rve-rule">Reader AI не объявляет Known все ≈ ${formatNumber(profile.estimate)} слов. Автоматически Known становятся только ${formatNumber(profile.conservativeKnownCount)} самых частых. Ручные решения имеют приоритет.</div><button class="rve-primary rve-done" type="button">Готово</button><button class="rve-secondary" type="button">Пройти ещё раз</button></div>`,{title:'Measure my level'});bindModalChrome(modal);modal.querySelector('.rve-done')?.addEventListener('click',openVocabularyDashboard);modal.querySelector('.rve-secondary')?.addEventListener('click',()=>startAssessment(englishData));}
function closeVocabularyEstimate(){document.getElementById(MODAL_ID)?.remove();assessment=null;}

function installExtraStyles() {
  if (document.getElementById('reader-en-vocab-style-v1')) return;
  const style=document.createElement('style'); style.id='reader-en-vocab-style-v1';
  style.textContent=`
    #${MODAL_ID} .rve-word-chip-en { font-family:'IBM Plex Sans',system-ui,sans-serif !important;font-size:1.18rem !important;min-width:92px;max-width:190px; }
    #reader-reading-view .rd-en-vocab-btn { font-family:'IBM Plex Sans',system-ui,sans-serif;font-weight:800; }
  `;
  document.head.appendChild(style);
}
function queueWordNode(node){if(!(node instanceof Element))return;if(node.classList.contains('reader-word'))pendingWordNodes.add(node);node.querySelectorAll?.('.reader-word').forEach(word=>pendingWordNodes.add(word));}
function flushPendingWordNodes(){pendingBatchScheduled=false;if(pendingWordNodes.size&&currentLang()==='en'){const batch=Array.from(pendingWordNodes);pendingWordNodes.clear();applyClassificationBatch(batch);}else pendingWordNodes.clear();ensureVocabularyButton();}
function schedulePendingWordBatch(){if(pendingBatchScheduled)return;pendingBatchScheduled=true;requestAnimationFrame(flushPendingWordNodes);}
function installRenderObserver(){if(typeof MutationObserver==='undefined')return;const root=document.getElementById('reader-chapter-text');if(!root){setTimeout(installRenderObserver,250);return;}if(renderObserver&&renderObserverRoot===root)return;renderObserver?.disconnect();renderObserverRoot=root;renderObserver=new MutationObserver(records=>{if(currentLang()!=='en')return;for(const record of records)for(const node of record.addedNodes||[])queueWordNode(node);if(pendingWordNodes.size)schedulePendingWordBatch();});renderObserver.observe(root,{childList:true,subtree:true});if(currentLang()==='en'){root.querySelectorAll('.reader-word').forEach(word=>pendingWordNodes.add(word));schedulePendingWordBatch();}}
function ensureVocabularyButton(){const top=document.querySelector('#reader-reading-view .rd-top');if(!top)return null;let button=document.getElementById('reader-en-vocab-btn');if(!button){button=document.createElement('button');button.id='reader-en-vocab-btn';button.type='button';button.className='rd-icon rd-en-vocab-btn';button.textContent='W';button.title='English vocabulary · Measure my level';button.setAttribute('aria-label','English vocabulary and level estimate');button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openVocabularyDashboard();});const zh=document.getElementById('reader-vocab-btn');const pinyin=document.getElementById('reader-pinyin-btn');if(zh?.parentNode===top)top.insertBefore(button,zh);else if(pinyin?.parentNode===top)top.insertBefore(button,pinyin);else top.appendChild(button);}button.style.display=currentLang()==='en'?'':'none';return button;}
function installPanelHook(){if(document.documentElement?.dataset?.readerEnVocabPanelHook==='1')return;if(document.documentElement)document.documentElement.dataset.readerEnVocabPanelHook='1';document.addEventListener('click',event=>{if(currentLang()!=='en')return;const target=event.target instanceof Element?event.target:null;if(!target?.closest?.('#reader-chapter-text .reader-word'))return;queueMicrotask(()=>{decorateWordPanel();syncPanelKnowledge();});setTimeout(()=>{decorateWordPanel();syncPanelKnowledge();},40);},true);}
function warmEnglishDataWhenUseful(){if(currentLang()!=='en'&&!loadProfile())return;const run=()=>loadEnglishData().then(()=>{if(currentLang()==='en')return applyEstimateToRenderedWords();}).catch(error=>console.warn('[reader en vocab] warmup failed',error?.message||error));if(typeof requestIdleCallback==='function')requestIdleCallback(run,{timeout:900});else setTimeout(run,250);}
function boot(){installExtraStyles();ensureVocabularyButton();installPanelHook();installRenderObserver();if(currentLang()==='en')decorateWordPanel();warmEnglishDataWhenUseful();}

export function installEnglishVocabularyEstimate(){if(typeof document==='undefined'||typeof document.createElement!=='function')return;if(globalThis.__readerEnglishVocabularyEstimateVersion===1)return;globalThis.__readerEnglishVocabularyEstimateVersion=1;globalThis.readerOpenEnglishVocabularyEstimate=openVocabularyDashboard;globalThis.readerStartEnglishVocabularyEstimate=openVocabularyEstimate;globalThis.readerApplyEnglishVocabularyEstimate=applyEstimateToRenderedWords;globalThis.readerEnglishVocabularyKnowledgeFor=classificationFor;globalThis.readerEnglishLemmaFor=lemmaForWordSync;globalThis.readerEnglishVocabularyProfile=loadProfile;globalThis.readerLoadEnglishVocabularyData=loadEnglishData;if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();window.addEventListener('pageshow',boot);window.addEventListener('reader:en-vocab-ready',()=>{if(currentLang()==='en')applyEstimateToRenderedWords().catch(()=>{});});}
installEnglishVocabularyEstimate();

export { conservativeCountForEstimate, estimateFromChecks, selectStep1Indices, selectStep2Indices, lemmaForWordSync };

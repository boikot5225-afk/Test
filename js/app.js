// ════════════════════════════════════════════════
// app.js — главный модуль, точка входа — v73
// ════════════════════════════════════════════════
console.log('[app] v75.3-dict-render loaded');

import { todayStr, addDays, profileKey, showToast, showLoading, hideLoading, toDateStr, normalizeImportKey, escapeAttr } from './utils.js';
import { initSupabase, isSupabaseReady, sb, sbUser, setSbUser, sbSignIn, sbSignUp, sbSignOut,
         sbGetProfile, sbLoadStats, sbLoadSRS, sbLoadMeta, fetchWithTimeout, LONG_REQUEST_TIMEOUT_MS, SUPABASE_URL, SUPABASE_KEY, ADMIN_USERNAME, sbIsCurrentUserAdmin, sbGetCurrentUserId,
         fbSaveWordState, fbLoadWordState } from './supabase.js';
import { setCurrentProfile, isGuest, setIsGuest, NOUNS, NOUNS_LOADED, setNounsLoaded } from './state.js';
import { sm2Update, loadSRS, saveSRS, mergeSRS, flushFailedSync, sanitizeSRS, srsKey, verbHasAnyCard, SRS_TENSES } from './srs.js';
import { loadStats, saveStats, loadMeta, saveMeta, syncStatsFromCloud,
         loadLearnLater, addLearnLater, removeLearnLater, isInLearnLater } from './storage.js';
import { speak, stopSpeak, initSpeech, applyKbMode, initTTSEngineUI, showFrKb, hideFrKb, isFrKbEnabled, setTTSEngine,
         frKbEnabled, autoSpeak, toggleAutoSpeak, toggleKbMode, insertFrChar,
         frBackspace, frEnter, frToggleShift } from './tts.js?v=68.32-firebase-tts';
import { renderHome } from './home.js';
import { renderZhTrainer } from './zh_trainer.js';
import { renderStats, confirmReset } from './stats.js';
import { renderNumbersScreen, nextNumber, checkNumber, speakCurrentNumber } from './numbers.js';
import { renderGroupsHome, openGroup, backToGroups, gNextCard, gCheckAnswer, gShowHint, IRR_GROUPS } from './groups.js';
import { renderDict, selectDictVerb, closeDictDetail, setDictLayout,
         dictSelected, selectedVerbIds, vpGroupFilter,
         renderVerbPicker, toggleVpVerb, updateVpCount, setVpFilter, deleteCustomVerb } from './dict.js';
import { renderPhrasesScreen, nextPhrase, checkPhrase, phraseHint, currentPhrase as phraseCurrent,
         getFilteredPhrases, showGenerateModal, showGenerateModalForVerb,
         closeGenerateModal, generatePhrases, populateGenVerbList,
         showAddPhraseModal, showAddPhraseModalForVerb, closeAddPhraseModal, saveManualPhrase, populateAddPhraseVerbList,
         showEditPhraseModal, deleteCurrentPhrase, speakCurrentPhrase,
         renderPhrasesVerbList, togglePhVerbSelect, phSelectedVerbs } from './phrases.js';
import { renderStudyScreen, learnVerbStart, renderLearnCard, startLearnCheck,
         showLearnCheckForm, checkLearnAnswer, startPhrasesStep, advancePhrase,
         showPhraseForm, checkPhraseAnswer, finishLearn, exitLearnSession,
         startLearnSession, startSelectedSession, startLearnLaterSession, toggleSelectMode, toggleVerbSelect,
         updateSelectedBar, clearStudySelection, initPhraseCountButtons, setPhraseCount,
         toggleKnownList, studySelectedIds, studySelectMode, studyQueue, studyQueueIdx,
         learnVerb, getLearnVerb, backToLearnCard } from './study.js';
import { pickCard, renderCard, checkAnswer, srsSessionActive, isSrsSessionActive, srsSessionHasNext, endSrsSession, startSrsSession, srsSessionDone, srsSessionTotal,
         srsSessionSkipVerb, srsFormsRemaining, srsFormsTotal, srsCurrentCardKey,
         clearFeedback, showHint, markAsKnown, recallResult, revealRecall,
         recordResult, updateSRSVerb, getCorrectAnswer, buildExample,
         getReflexivePronoun, getAgreedPP, currentVerb, currentPronounIdx, currentTense, getCurrentVerb, getCurrentTense,
         sessionGood, sessionBad, sessionStreak, reviewMode, setReviewMode, selectedVerbIds as trainerSelectedVerbIds } from './trainer.js';

import {
  syncWordStateToCloud, syncWordStateFromCloud, scheduleWordStateCloudSync,
  profileNameStorageKey, getCachedProfileName, setCachedProfileName, setActiveProfileName,
  readerSwitchStorageOwner, readerCurrentBook,
  loadReaderBooks, saveReaderBooks, loadReaderBooksFromCloud,
  scheduleReaderCloudSave, saveReaderBooksToCloud, syncReaderCloudNow,
  readerSplitTextToChapters, readerSplitSongToChapters,
  readerBookProgress, readerContinueBook,
  loadReaderWordState, saveReaderWordState, loadReaderLexicalCache, saveReaderLexicalCache,
  readerGetWordState, readerWordVisual, readerWordStateKey, readerMarkWordSaved, readerTouchWordState,
  readerRefreshParagraphWordClasses, readerTimeToday,
  readerCurrentLang, readerBookLang, readerTokenizeParagraph,
  renderReaderScreen, readerOpenBook, readerBackToLibrary,
  readerNextParagraph, readerPrevParagraph, readerNextChapter, readerPrevChapter,
  readerOpenToc, readerCloseToc, readerGoToChapter,
  readerOpenWordPanel, readerCloseWordPanel,
  readerSpeakParagraph, readerSpeakCurrentParagraph, readerSpeakChapter, readerSpeakText, readerStopSpeech,
  readerCopyParagraph, readerCopyCurrentParagraph,
  readerDeleteBook, readerSetComprehension, readerSpeakSelectedWord, readerSpeakSelectedContext,
  readerPrefillAddVerbFromPanel, readerSendParagraphToPhrase, readerSelectParagraph,
  readerSaveWord, readerTranslateWordAI, readerTranslateParagraphAI, readerAnalyzeParagraphAI, readerAction,
  readerListenToggle, readerOpenMoreSheet, readerCloseMoreSheet,
  bindReaderParagraphEvents, toggleReaderTranslations,
  showReaderViewedWords, closeReaderViewedWords,
  readerMarkSelectedWordKnown, readerMarkSelectedWordProblem,
  readerCycleZhPinyinMode, readerLookupChineseWord, readerEnsureZhCoreJsonLoaded, readerZhCoreJsonCount,
  readerZhCoreJson, readerZhCoreJsonPromise,
  readerSetLibTab, readerSetLibFilter, readerFetchFromUrl,
  readerImportFromFile, saveReaderImport, showReaderImportModal, closeReaderImportModal,
  readerToggleDisplayPanel, readerCloseDisplayPanel, rdSetFont, rdSetSize, rdSetLH, rdSetTheme,
  readerToggleSongMeaning,
  READER_BOOKS_KEY, READER_LANG_META,
  readerCanonicalLang, readerAI,
  readerLookupChineseJsonEntry, readerEscape, readerExtractPinyin,
  readerGetCachedLexical, readerPutCachedLexical, readerLexicalCacheKey,
  readerNormalizeWord, readerPosRu, readerScopedKey,
  readerSearchZhCoreJson, readerZhEntryFromSources,
  readerWordStatusRu, renderReaderChapter,
} from './reader-app.js';
import { dictNounsCache, dictPrepsCache, dictType, setDictTypeValue } from './dict-render.js';
// ── Глобальное состояние ──
export let currentProfile = null;
export let VERBS = [];
export let PHRASES = [];
export let VERBS_LOADED = false;
export let PHRASES_LOADED = false;
let currentUserIsFirebaseAdmin = false;

// v68: активный язык обучения (Фаза 1 — только французский, переключатель позже).
if (!globalThis.AN2_LANG) {
  try { globalThis.AN2_LANG = localStorage.getItem('an2_lang') || 'fr'; } catch { globalThis.AN2_LANG = 'fr'; }
}

// v68: кэш словарей теперь поязыковой (база личная и пустая по умолчанию).
const VERBS_CACHE_KEY = `an2_cache_verbs_${globalThis.AN2_LANG}_v32`;
const PHRASES_CACHE_KEY = `an2_cache_phrases_${globalThis.AN2_LANG}_v32`;

function canEditSharedDictionary() {
  // UI-gate only. Real protection is in Firebase Rules: /admins/<UID> = true.
  // We still show editor for signed-in users because old username-based admin
  // checks can be stale after Firebase migration. If Rules deny, save will show
  // the Firebase permission error instead of silently hiding the whole editor.
  return !isGuest && (!!sbUser || !!currentProfile || currentUserIsFirebaseAdmin || currentProfile?.toLowerCase() === ADMIN_USERNAME);
}

async function refreshFirebaseAdminStatus() {
  try { currentUserIsFirebaseAdmin = !!(await sbIsCurrentUserAdmin()); }
  catch (e) { currentUserIsFirebaseAdmin = false; console.warn('[admin] status check skipped:', e?.message || e); }
  try {
    const addVerbBtn = document.getElementById('add-verb-btn');
    if (addVerbBtn) addVerbBtn.style.display = canEditSharedDictionary() ? 'inline-block' : 'none';
    const genBtn = document.getElementById('ph-generate-btn');
    if (genBtn) genBtn.style.display = canEditSharedDictionary() ? '' : 'none';
    const editBtn = document.getElementById('ph-edit-current-btn');
    const delBtn = document.getElementById('ph-delete-current-btn');
    if (editBtn) editBtn.style.display = canEditSharedDictionary() ? '' : 'none';
    if (delBtn) delBtn.style.display = canEditSharedDictionary() ? '' : 'none';
    const clearWordsBtn = document.getElementById('dict-clear-words-btn');
    if (clearWordsBtn) clearWordsBtn.style.display = (dictType === 'nouns' && canEditSharedDictionary()) ? 'inline-block' : 'none';
  } catch {}
}

const AUTH_TIMEOUT_MS = 65000;
const CORE_LOAD_TIMEOUT_MS = 30000;
const OPTIONAL_CLOUD_TIMEOUT_MS = 25000;
const PHRASES_PAGE_TIMEOUT_MS = 30000;
const PHRASES_TOTAL_TIMEOUT_MS = 60000;
let phrasesBackgroundPromise = null;

function getErrorMessage(e, fallback = 'Ошибка') {
  return e?.message || String(e || fallback);
}

async function withDeadline(work, ms, label = 'Операция') {
  let timer = null;
  const task = typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} не ответил за ${Math.round(ms / 1000)} сек.`)), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runOptional(label, work, ms = OPTIONAL_CLOUD_TIMEOUT_MS) {
  try {
    return await withDeadline(work, ms, label);
  } catch (e) {
    console.warn(`[optional] ${label}:`, getErrorMessage(e));
    return null;
  }
}

function safeJsonParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}

function saveCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { console.warn('[cache] save skipped:', getErrorMessage(e)); }
}

function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[cache] read failed:', getErrorMessage(e));
    return null;
  }
}

// Диагностика после миграции: вручную стереть локальный кэш словарей.
window.clearAn2DictionaryCache = function() {
  try {
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith('an2_cache_verbs') || k.startsWith('an2_cache_phrases')) localStorage.removeItem(k);
    });
    VERBS.length = 0; PHRASES.length = 0;
    VERBS_LOADED = false; PHRASES_LOADED = false;
    console.warn('[cache] dictionary cache cleared');
    showToast('Кэш словарей очищен. Обнови страницу.');
  } catch (e) {
    console.warn('[cache] clear failed:', getErrorMessage(e));
  }
};

function restoreVerbsFromCache() {
  const cached = loadCache(VERBS_CACHE_KEY);
  if (!Array.isArray(cached) || !cached.length) return false;
  VERBS.length = 0;
  cached.forEach(v => VERBS.push(v));
  VERBS_LOADED = true;
  console.warn('[verbs] restored from local cache:', VERBS.length);
  return true;
}

function restorePhrasesFromCache() {
  const cached = loadCache(PHRASES_CACHE_KEY);
  if (!Array.isArray(cached) || !cached.length) return false;
  PHRASES.length = 0;
  cached.forEach(p => PHRASES.push(p));
  PHRASES_LOADED = true;
  console.warn('[phrases] restored from local cache:', PHRASES.length);
  return true;
}

function applyCloudProgress(cloudStats, cloudSRS, cloudMeta, opts = {}) {
  if (!currentProfile) return;

  if (cloudStats && Object.keys(cloudStats).length) {
    if (opts.mergeStats) {
      // Background sync after the app is already usable: the user may have
      // answered cards meanwhile. Don't overwrite — merge per key, keeping
      // whichever entry has seen more attempts.
      const local = safeJsonParse(localStorage.getItem(profileKey('stats', currentProfile)), {});
      for (const [k, v] of Object.entries(cloudStats)) {
        if (!local[k] || (v.total || 0) >= (local[k].total || 0)) local[k] = v;
      }
      localStorage.setItem(profileKey('stats', currentProfile), JSON.stringify(local));
    } else {
      localStorage.setItem(profileKey('stats', currentProfile), JSON.stringify(cloudStats));
    }
  }

  if (cloudSRS && Object.keys(cloudSRS).length) {
    const localSRS = safeJsonParse(localStorage.getItem(profileKey('srs', currentProfile)), {});
    const merged = mergeSRS(localSRS, cloudSRS);
    const { srs: cleaned, changed } = sanitizeSRS(merged);
    localStorage.setItem(profileKey('srs', currentProfile), JSON.stringify(cleaned));
    if (changed) saveSRS(cleaned);
  }

  if (cloudMeta) {
    localStorage.setItem(profileKey('meta', currentProfile), JSON.stringify(cloudMeta));
  }
}

async function ensureProfileForUser(user, email) {
  let profile = await runOptional('Профиль', () => sbGetProfile(), OPTIONAL_CLOUD_TIMEOUT_MS);
  if (profile?.username) return profile;

  const username = email?.split('@')[0] || 'user';
  await runOptional('Создание профиля', () => sb.from('profiles').insert({ id: user.id, username }), OPTIONAL_CLOUD_TIMEOUT_MS);
  return { username };
}

function startPhrasesBackgroundLoad() {
  if (PHRASES_LOADED || phrasesBackgroundPromise) return phrasesBackgroundPromise;
  phrasesBackgroundPromise = withDeadline(() => loadPhrasesFromCloud(), PHRASES_TOTAL_TIMEOUT_MS, 'Фразы')
    .then(() => {
      if (PHRASES_LOADED) {
        console.log('[phrases] background loaded:', PHRASES.length);
        const screen = document.getElementById('screen-phrases');
        if (screen?.classList.contains('active')) {
          window.renderPhrasesScreen?.().catch?.((e) => console.warn('[phrases] rerender failed:', getErrorMessage(e)));
        }
      }
    })
    .catch((e) => console.warn('[phrases] background load skipped:', getErrorMessage(e)))
    .finally(() => { phrasesBackgroundPromise = null; });
  return phrasesBackgroundPromise;
}

// Expose to window for inline HTML handlers
window.speak = speak;
window.getCurrentVerb = getCurrentVerb;
// Speak text stored in a data attribute (safe for apostrophes/quotes in French)
window.speakText = (btn) => { const t = btn?.dataset?.speak; if (t) speak(t); };
window.togglePhSetup = () => {
  const setup = document.getElementById('ph-setup-area');
  const toggle = document.getElementById('ph-setup-toggle');
  if (!setup) return;
  const hidden = setup.style.display === 'none';
  setup.style.display = hidden ? 'block' : 'none';
  // keep the toggle visible so the user can collapse again
  if (toggle) toggle.style.display = 'block';
};
window.showScreen = showScreen;
window.checkAnswer = () => checkAnswer(resetTrainer);
window.resetTrainer = resetTrainer;
// "Понял паттерн" — mark the current verb fully reviewed and move on
window.skipPattern = () => {
  const v = getCurrentVerb();
  if (!v || !isSrsSessionActive()) return;
  const key = srsCurrentCardKey();
  const tense = getCurrentTense();
  srsSessionSkipVerb(key);                       // remove this card from queue
  updateSRSVerb(v.id, true, undefined, tense);   // advance interval for this tense
  resetTrainer();                                // next card (or completion)
};
window.showHint = showHint;
window.markAsKnown = markAsKnown;
window.revealRecall = revealRecall;
window.recallResult = (g) => recallResult(g, resetTrainer);
window.selectDictVerb = (id) => selectDictVerb(id, VERBS, currentProfile);

// Fill the verb card's example block with phrases from the phrase base
window.renderVerbExamples = (verbId) => {
  const block = document.getElementById('verb-examples-block');
  if (!block) return;
  const phrases = PHRASES.filter(p => p.verbId === verbId && p.fr && p.ru);
  const verb = VERBS.find(v => v.id === verbId);
  const tenseLabels = {
    present:'Présent', passe:'Passé composé', imparfait:'Imparfait', futur:'Futur simple',
    plus_que_parfait:'Plus-que-parfait', conditionnel:'Conditionnel', subjonctif:'Subjonctif', imperatif:'Impératif', passe_simple:'Passé simple'
  };
  const manualExamples = [];
  if (verb?.ex && typeof verb.ex === 'object') {
    Object.entries(verb.ex).forEach(([tense, fr]) => {
      if (fr) manualExamples.push({ id:'ex_' + tense, tense, fr, answer:'', ru:'пример из карточки глагола' });
    });
  }
  const all = [...phrases, ...manualExamples];
  if (!all.length) {
    block.innerHTML = `
      <div style="margin-top:8px;margin-bottom:20px;background:var(--surface2);border:1px dashed var(--border);border-radius:10px;padding:14px;text-align:center;color:var(--text-muted);font-size:0.82rem">
        Примеров пока нет. ${window.isAdmin && window.isAdmin() ? `<button onclick="window.showAddPhraseModalForVerb && window.showAddPhraseModalForVerb('${verbId}')" class="btn btn-secondary" style="margin-left:8px;padding:5px 10px;font-size:0.75rem">+ Фраза</button>` : ''}
      </div>`;
    return;
  }
  const byTense = new Map();
  for (const p of all) {
    const key = p.tense || 'present';
    if (!byTense.has(key)) byTense.set(key, []);
    if (byTense.get(key).length < 4) byTense.get(key).push(p);
  }
  const sections = [...byTense.entries()].map(([tense, items]) => {
    const rows = items.map(p => {
      const answer = p.answer || '';
      const frDisplay = (p.fr || '').replace('___', `<strong style="color:var(--accent)">${answer}</strong>`);
      const frSpeak = (p.fr || '').replace('___', answer).replace(/"/g, '&quot;');
      return `<div style="display:flex;align-items:flex-start;gap:8px;padding:9px 0;border-bottom:1px solid rgba(120,90,60,0.12)">
        <div style="flex:1;min-width:0">
          <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.96rem;color:var(--text);margin-bottom:3px;line-height:1.4">${frDisplay}</div>
          <div style="font-size:0.78rem;color:var(--text-muted)">${p.ru || ''}</div>
        </div>
        <button data-speak="${frSpeak}" onclick="speak(this.dataset.speak)" title="Произнести" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.85rem;flex-shrink:0;padding:2px;opacity:0.6" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">🔊</button>
      </div>`;
    }).join('');
    return `<details open style="margin-bottom:10px"><summary style="cursor:pointer;color:var(--accent);font-size:0.82rem;margin-bottom:6px">${tenseLabels[tense] || tense} · ${items.length}</summary>${rows}</details>`;
  }).join('');
  block.innerHTML = `
    <div style="margin-top:8px;margin-bottom:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div style="font-family:'Playfair Display',serif;font-size:0.95rem;color:var(--text-dim);font-weight:600">📝 Примеры по временам</div>
        ${window.isAdmin && window.isAdmin() ? `<button onclick="window.showAddPhraseModalForVerb && window.showAddPhraseModalForVerb('${verbId}')" class="btn btn-secondary" style="padding:5px 10px;font-size:0.75rem">+ Фраза</button>` : ''}
      </div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:8px 14px">${sections}</div>
    </div>`;
};window.closeDictDetail = closeDictDetail;
window.renderDict = () => renderDict(VERBS, VERBS_LOADED, loadVerbsFromCloud);
window.nextPhrase = () => nextPhrase(PHRASES, VERBS);
window.checkPhrase = () => checkPhrase(PHRASES, VERBS);
window.phraseHint = phraseHint;
window.showGenerateModal = () => showGenerateModal(currentProfile, VERBS);
window.showGenerateModalForVerb = (id) => showGenerateModalForVerb(id, currentProfile, VERBS);
window.closeGenerateModal = closeGenerateModal;
window.generatePhrases = () => generatePhrases(PHRASES, VERBS, async () => {
  await loadPhrasesFromCloud({ force: true }); // legacy DeepSeek path, left as fallback only
  renderPhrasesScreen(PHRASES, VERBS, VERBS_LOADED, PHRASES_LOADED, loadVerbsFromCloud, loadPhrasesFromCloud);
});
window.filterGenVerbs = () => populateGenVerbList(document.getElementById('gen-verb-search')?.value || '', VERBS);
window.showAddPhraseModal = () => showAddPhraseModal(currentProfile, VERBS);
window.showAddPhraseModalForVerb = (id) => showAddPhraseModalForVerb(id, currentProfile, VERBS);
window.closeAddPhraseModal = closeAddPhraseModal;
window.populateAddPhraseVerbList = () => populateAddPhraseVerbList(VERBS);
window.editCurrentPhrase = () => {
  showEditPhraseModal(phraseCurrent, currentProfile, VERBS);
};
window.deleteCurrentPhrase = () => deleteCurrentPhrase(PHRASES, async () => {
  PHRASES_LOADED = false;
  await loadPhrasesFromCloud({ force: true });
  renderPhrasesScreen(PHRASES, VERBS, VERBS_LOADED, PHRASES_LOADED, loadVerbsFromCloud, loadPhrasesFromCloud);
});
window.speakCurrentPhrase = speakCurrentPhrase;
window.saveManualPhrase = () => saveManualPhrase(PHRASES, VERBS, async () => {
  PHRASES_LOADED = false;
  await loadPhrasesFromCloud({ force: true });
  renderPhrasesScreen(PHRASES, VERBS, VERBS_LOADED, PHRASES_LOADED, loadVerbsFromCloud, loadPhrasesFromCloud);
});
window.learnVerbStart = (id) => learnVerbStart(id, VERBS);
// Learn a specific verb in a specific tense (from the per-tense chips)
window.learnVerbInTense = (id, tense) => {
  learnVerbStart(id, VERBS);        // loads verb, defaults to présent
  // Now override to the chosen tense and re-render the table + label
  window.learnCurrentTense = tense;
  const TENSE_NAMES = { present:'Présent', passe:'Passé composé', imparfait:'Imparfait', futur:'Futur simple' };
  const stepLabel = document.getElementById('study-step-label');
  if (stepLabel) stepLabel.textContent = `Шаг 1 из 2 — знакомство · ${TENSE_NAMES[tense] || ''}`;
  window.renderLearnTenseTable();
};
// Remove a verb from the personal study plan (learn-later list)
window.removeFromPlan = (id) => {
  removeLearnLater(id);
  window.renderStudyScreen().catch(e => console.error(e));
};
window.startLearnCheck = () => startLearnCheck(frKbEnabled, showFrKb, hideFrKb);
window.showLearnCheckForm = () => showLearnCheckForm(frKbEnabled, showFrKb, hideFrKb);
window.checkLearnAnswer = () => checkLearnAnswer(PHRASES, PHRASES_LOADED, loadPhrasesFromCloud, frKbEnabled, showFrKb, hideFrKb);
window.startPhrasesStep = () => startPhrasesStep(PHRASES, PHRASES_LOADED, loadPhrasesFromCloud, frKbEnabled, showFrKb, hideFrKb);
window.advancePhrase = () => advancePhrase(frKbEnabled, showFrKb, hideFrKb);
window.showPhraseForm = () => showPhraseForm(frKbEnabled, showFrKb, hideFrKb);
window.checkPhraseAnswer = () => checkPhraseAnswer(frKbEnabled, showFrKb, hideFrKb);
window.finishLearn = () => finishLearn(() => startLearnSession(VERBS));
window.exitLearnSession = () => exitLearnSession(() => renderStudyScreen(VERBS, VERBS_LOADED, PHRASES_LOADED, loadVerbsFromCloud, loadPhrasesFromCloud, frKbEnabled, autoSpeak, currentProfile));
window.startLearnSession = () => startLearnSession(VERBS);
window.startSelectedSession = () => startSelectedSession(VERBS);
window.renderStudyScreen = () => renderStudyScreen(VERBS, VERBS_LOADED, PHRASES_LOADED, loadVerbsFromCloud, loadPhrasesFromCloud, frKbEnabled, autoSpeak, currentProfile);
window.toggleSelectMode = () => toggleSelectMode(() => window.renderStudyScreen());
window.toggleVerbSelect = (id) => toggleVerbSelect(id, () => window.renderStudyScreen());
window.clearStudySelection = () => clearStudySelection(() => window.renderStudyScreen());
window.setPhraseCount = setPhraseCount;
window.toggleKnownList = toggleKnownList;
window.toggleAutoSpeak = toggleAutoSpeak;
window.toggleKbMode = toggleKbMode;
window.insertFrChar = insertFrChar;
window.frBackspace = frBackspace;
window.frEnter = frEnter;
window.frToggleShift = frToggleShift;
window.logoutProfile = logoutProfile;
window.doLogin = doLogin;
window.doRegister = doRegister;
// Emergency door for auth glitches: if Firebase already has a user, open app shell
// without waiting for dictionaries/profile. Useful after PWA/cache/auth weirdness.
window.an2AuthRescue = async function an2AuthRescue() {
  try {
    if (!initSupabase()) throw new Error('Firebase init failed');
    const sessionResult = await sb.auth.getSession();
    const session = sessionResult?.data?.session;
    if (!session?.user) throw new Error('Активной Firebase-сессии нет. Войди заново.');
    setSbUser(session.user);
    currentProfile = setActiveProfileName(getCachedProfileName(session.user) || session.user.email?.split('@')[0] || 'user', session.user);
    VERBS_LOADED = true;
    loginProfile(currentProfile);
    return { ok: true, user: session.user.email || session.user.uid };
  } catch (e) {
    showAuthError('Auth rescue: ' + getErrorMessage(e));
    return { ok: false, error: getErrorMessage(e) };
  }
};
window.showToast = showToast;
// True only for the admin account (you). Used to gate generation.
window.isAdmin = () => canEditSharedDictionary();
// Block account-only actions for guests; returns true if blocked
window.guardGuest = (action) => {
  if (isGuest) {
    showToast('🔒 ' + (action || 'Эта функция') + ' доступна после входа');
    return true;
  }
  return false;
};
window.switchAuthTab = switchAuthTab;
window.renderPhrasesScreen = () => renderPhrasesScreen(PHRASES, VERBS, VERBS_LOADED, PHRASES_LOADED, loadVerbsFromCloud, loadPhrasesFromCloud);
window.renderPhrasesVerbList = () => renderPhrasesVerbList(VERBS);
window.togglePhVerbSelect = () => togglePhVerbSelect(VERBS);
// Internal verb toggle for phrase filter
window._phToggleVerb = (id) => {
  import('./phrases.js').then(m => {
    if (m.phSelectedVerbs.has(id)) m.phSelectedVerbs.delete(id);
    else m.phSelectedVerbs.add(id);
    renderPhrasesVerbList(VERBS);
    const n = m.phSelectedVerbs.size;
    // Update select button
    const btn = document.getElementById('ph-select-btn');
    if (btn) btn.textContent = n > 0 ? `☑ Выбрано: ${n}` : '☑ Выбрать';
    // Show/hide selected bar
    const bar = document.getElementById('ph-selected-bar');
    const label = document.getElementById('ph-selected-label');
    if (bar) bar.style.display = n > 0 ? 'flex' : 'none';
    if (label) label.textContent = `Выбрано: ${n}`;
    // Restart phrase with new filter
    window.nextPhrase?.();
  });
};

window.startPhrasesWithSelected = () => {
  // Close verb list and start training
  const list = document.getElementById('ph-verb-list');
  if (list) list.style.display = 'none';
  window.nextPhrase?.();
};

window.clearPhVerbSelection = () => {
  import('./phrases.js').then(m => {
    m.phSelectedVerbs.clear();
    const btn = document.getElementById('ph-select-btn');
    if (btn) btn.textContent = '☑ Выбрать';
    const bar = document.getElementById('ph-selected-bar');
    if (bar) bar.style.display = 'none';
    const list = document.getElementById('ph-verb-list');
    if (list) list.style.display = 'none';
    window.nextPhrase?.();
  });
};
window._nextPhrase = () => nextPhrase(PHRASES, VERBS);
// Numbers
window.nextNumber = nextNumber;
window.checkNumber = checkNumber;
window.speakCurrentNumber = speakCurrentNumber;
// Groups
window.openGroup = (id) => openGroup(id, VERBS);
window.backToGroups = backToGroups;
window.gNextCard = () => gNextCard(VERBS);
window.gCheckAnswer = () => gCheckAnswer(VERBS);
window.gShowHint = gShowHint;
// Stats
window.confirmReset = () => confirmReset(VERBS, () => renderStats(VERBS, NOUNS), () => renderHome(VERBS));
// Study helpers
window.learnAgain = () => renderLearnCard(autoSpeak, currentProfile, showFrKb);
window.studyOneVerb = (id) => learnVerbStart(id, VERBS);

// ── Мой план (бывш. «Изучить позже») ──
window.toggleLearnLater = (verbId) => {
  const btn = document.getElementById('ll-btn-' + verbId);
  if (isInLearnLater(verbId)) {
    removeLearnLater(verbId);
    if (btn) btn.textContent = '➕ В мой план';
    showToast('Убрано из плана');
  } else {
    addLearnLater(verbId);
    if (btn) btn.textContent = '✓ В плане';
    showToast('✓ Добавлено в «Мой план»');
  }
  updateLearnLaterBadges();
};

function getValidLearnLaterIds() {
  const raw = loadLearnLater();
  const valid = raw.filter(id => VERBS.some(v => v.id === id));
  if (valid.length !== raw.length) {
    try { localStorage.setItem(profileKey('learnlater', currentProfile), JSON.stringify(valid)); } catch {}
  }
  return valid;
}

function updateLearnLaterBadges() {
  const llCount = getValidLearnLaterIds().length;
  const ids = ['qa-ll-badge','study-ll-count'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = llCount; el.style.display = llCount > 0 ? (id === 'qa-ll-badge' ? 'block' : 'inline-block') : 'none'; }
  });
}

function renderLearnLaterList() {
  const ids = getValidLearnLaterIds();
  const listEl = document.getElementById('learn-later-list');
  const startBtn = document.getElementById('learn-later-start-btn');
  if (!listEl) return;
  if (!ids.length) {
    listEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.85rem">Список пуст.<br>Добавь глаголы из Словаря кнопкой «➕ В мой план».</div>`;
    if (startBtn) startBtn.style.display = 'none';
    return;
  }
  if (startBtn) startBtn.style.display = 'block';
  listEl.innerHTML = ids.map(id => {
    const v = VERBS.find(x => x.id === id);
    if (!v) return '';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;">
      <div style="flex:1;min-width:0">
        <div style="font-family:Georgia,serif;font-style:italic;font-size:1rem;color:var(--text)">${v.inf}</div>
        <div style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.meaning || ''}</div>
      </div>
      <button onclick="removeFromLearnLater('${v.id}')" style="background:none;border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:6px 10px;font-size:0.75rem;cursor:pointer;white-space:nowrap">🗑</button>
    </div>`;
  }).join('');
}

window.startLearnLater = () => {
  renderLearnLaterList();
  const modal = document.getElementById('learn-later-modal');
  if (modal) modal.style.display = 'flex';
};

window.closeLearnLaterModal = () => {
  const modal = document.getElementById('learn-later-modal');
  if (modal) modal.style.display = 'none';
};

window.removeFromLearnLater = (verbId) => {
  removeLearnLater(verbId);
  renderLearnLaterList();
  // Refresh badges
  updateLearnLaterBadges();
};


window.clearLearnLaterPlan = () => {
  if (!confirm('Очистить «Мой план»? Статистика и SRS не удалятся.')) return;
  try { localStorage.setItem(profileKey('learnlater', currentProfile), JSON.stringify([])); } catch {}
  updateLearnLaterBadges();
  renderLearnLaterList();
  showToast('📌 План очищен');
};

window.startLearnLaterFromModal = () => {
  const ids = getValidLearnLaterIds();
  if (!ids.length) { showToast('Список пуст'); return; }
  window.closeLearnLaterModal();
  showScreen('study');
  startLearnLaterSession(ids, VERBS);
};
window.startTrainerVerb = (id) => {
  const v = VERBS.find(x => x.id === id);
  if (!v) return;
  // Train THIS specific verb — not its whole group.
  // End any SRS session and select just this verb so pickCard uses it.
  if (isSrsSessionActive()) endSrsSession();
  trainerSelectedVerbIds.clear();
  trainerSelectedVerbIds.add(id);
  // Reset group/tense filters so they don't exclude the verb
  const fg = document.getElementById('filter-group'); if (fg) fg.value = 'all';
  // Show the selection banner so it's clear only this verb is being trained
  const banner = document.getElementById('custom-selection-banner');
  const label = document.getElementById('custom-selection-label');
  if (banner) banner.style.display = 'flex';
  if (label) label.textContent = `Тренируется: ${v.inf}`;
  showScreen('trainer');
  setTrainerMode('verbs');
  restoreTrainerUI();
  resetTrainer();
};
// Dict picker
window.openVerbPicker = openVerbPicker;
window.closeVerbPicker = closeVerbPicker;
window.renderVerbPicker = () => renderVerbPicker(VERBS);
window.toggleVpVerb = toggleVpVerb;
window.setVpFilter = (g) => setVpFilter(g, VERBS);
window.deleteCustomVerb = (id) => {
  if (!confirm('Удалить этот глагол?')) return;
  deleteCustomVerb(id, VERBS, () => renderDict());
};
window.setTTSEngine = setTTSEngine;
window.vpSelectAll = () => { VERBS.forEach(v => selectedVerbIds.add(v.id)); renderVerbPicker(VERBS); };
window.vpClearAll = () => { selectedVerbIds.clear(); renderVerbPicker(VERBS); };
window.applyVerbSelection = applyVerbSelection;
window.clearVerbSelection = clearVerbSelection;
// Add verb modal
window.addVerb = addVerb;
window.closeAddVerbModal = closeAddVerbModal;
window.showAddVerbModal = showAddVerbModal;
window.editVerb = (id) => showAddVerbModal(id);


// ── Загрузка данных ──
export async function loadVerbsFromCloud(options = {}) {
  const { force = false } = options || {};
  if (VERBS_LOADED && !force) return true;
  if (!isSupabaseReady()) {
    console.warn('[verbs] Firebase is not ready; trying local cache');
    return restoreVerbsFromCache();
  }

  try {
    const { data, error } = await withDeadline(
      () => sb.from('verbs').select('*').order('inf'),
      CORE_LOAD_TIMEOUT_MS,
      'Загрузка глаголов'
    );
    if (error) throw error;
    // v68: пустая личная база — это нормальное стартовое состояние, а не ошибка.
    const rows = Array.isArray(data) ? data : [];

    VERBS.length = 0;
    rows.forEach(v => {
      const inf = v.inf || v.infinitive || v.id || '';
      const group = v.group_name || v.group || v.verb_group || 'irr';
      const conj = v.conj || v.conjugations || v.forms || null;
      VERBS.push({
        id: v.id || inf,
        inf,
        meaning: v.meaning || v.ru || v.translation || '',
        group,
        group_name: group,
        conj,
        pp: v.pp || v.past_participle || '',
        aux: v.aux || v.auxiliary || 'avoir',
        ex: v.ex || v.examples || {},
        reflexive: v.reflexive || false,
        custom: v.custom || false
      });
    });
    VERBS_LOADED = true;
    saveCache(VERBS_CACHE_KEY, VERBS);
    console.log('Loaded ' + VERBS.length + ' verbs from Firebase');
    return true;
  } catch(e) {
    console.error('Failed to load verbs:', getErrorMessage(e));
    if (restoreVerbsFromCache()) return true;
    showToast('⚠️ Не удалось загрузить глаголы');
    return false;
  }
}

export async function loadPhrasesFromCloud(options = {}) {
  const { force = false } = options || {};
  if (PHRASES_LOADED && !force) return true;
  if (!isSupabaseReady()) {
    console.warn('[phrases] Firebase is not ready; trying local cache');
    return restorePhrasesFromCache();
  }

  try {
    let allData = [], from = 0;
    const pageSize = 1000;
    const maxPages = 25;
    const started = Date.now();

    for (let page = 0; page < maxPages; page++) {
      if (Date.now() - started > PHRASES_TOTAL_TIMEOUT_MS) {
        throw new Error('загрузка фраз заняла слишком много времени');
      }
      const { data, error } = await withDeadline(
        () => sb.from('phrases').select('*').range(from, from + pageSize - 1),
        PHRASES_PAGE_TIMEOUT_MS,
        'Загрузка фраз'
      );
      if (error) throw error;
      if (!data || data.length === 0) break;
      allData = allData.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    PHRASES.length = 0;
    allData.forEach(p => {
      let fr = p.fr || '';
      const answer = p.answer || '';
      if (answer && !fr.includes('___')) {
        const re = new RegExp('\\b' + escapeRegExpForSearch(answer) + '\\b', 'i');
        fr = fr.replace(re, '___');
      }
      PHRASES.push({
        id: p.id,
        verbId: p.verb_id || p.verbId || p.verb || '',
        tense: p.tense || 'present',
        fr,
        answer,
        ru: p.ru || p.meaning || p.translation || '',
        level: p.level || p.difficulty || 'A2',
        custom: !!p.custom
      });
    });

    PHRASES_LOADED = true;
    saveCache(PHRASES_CACHE_KEY, PHRASES);
    console.log('Loaded ' + PHRASES.length + ' phrases from Firebase');
    return true;
  } catch(e) {
    console.error('Failed to load phrases:', getErrorMessage(e));
    if (restorePhrasesFromCache()) return true;
    PHRASES_LOADED = false;
    return false;
  }
}




// ── Навигация ──
export function showScreen(id) {
  if (id === 'profile') {
    const uid = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
    if (uid && !isGuest) {
      id = 'profile-user';
      setTimeout(() => renderUserProfile(), 0);
    } else {
      document.getElementById('main-app').style.display = 'none';
      const el = document.getElementById('screen-profile');
      if (el) el.style.display = 'flex';
      switchAuthTab('login');
      return;
    }
  }
  // Hide ALL French keyboards and clear their state when leaving any screen
  ['main','grp','ph','num','learn','phrase-learn'].forEach(kbId => {
    const kb = document.getElementById('fr-kb-' + kbId);
    if (kb) { kb.style.display = 'none'; kb.classList.remove('kb-visible'); }
  });
  // Remove kb-active compression class from all screens
  document.querySelectorAll('.kb-active').forEach(s => s.classList.remove('kb-active'));

  // End any active SRS session when navigating away from trainer
  if (id !== 'trainer' && isSrsSessionActive()) {
    endSrsSession();
    const rb = document.getElementById('review-banner');
    if (rb) rb.classList.remove('active');
  }
  // When entering the trainer normally (no active session), restore the card UI
  // so a leftover "completed" screen from a previous SRS session doesn't stick.
  if (id === 'trainer' && !isSrsSessionActive()) {
    restoreTrainerUI();
  }

  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  if (id !== 'reader') document.body.classList.remove('reader-mode');
  const target = document.getElementById('screen-' + id);
  if (target) { target.classList.add('active'); target.style.display = ''; }
  // Reset scroll to top on every screen change — prevents landing in empty
  // space when the previous screen was scrolled down.
  window.scrollTo(0, 0);
  const tabName = {home:'Главная',reader:'Читать',phrases:'Фразы',grammar:'Правила',trainer:'Тренажёр',study:'Изучить',stats:'Статистика',dict:'Слова',leaderboard:'Лидерборд',profile:'Профиль','profile-user':'Профиль'}[id];
  document.querySelectorAll('.nav-tab').forEach(t => {
    if (tabName && t.textContent.includes(tabName)) t.classList.add('active');
  });
  updateBottomNav(id);
  if (id !== 'dict') {
    const detailWrap = document.getElementById('dict-detail-wrap');
    const listWrap = document.getElementById('dict-list-wrap');
    if (detailWrap) detailWrap.style.display = 'none';
    if (listWrap) listWrap.style.display = 'block';
  }
  if (id === 'home')    Promise.resolve(renderHome()).catch(e => console.error(e));
  if (id === 'zh-trainer') Promise.resolve(renderZhTrainer()).catch(e => console.error(e));
  if (id === 'reader')  renderReaderScreen();
  if (id === 'stats')   {
    // Ensure nouns are loaded so stats show names, not raw ids (n10, n8…)
    loadNounsFromCloud().then(() => renderStats(VERBS, NOUNS)).catch(e => console.error(e));
  }
  if (id === 'dict') {
    const curDictLang = globalThis.AN2_LANG || 'fr';
    if (typeof window.setDictType === 'function') {
      if (curDictLang === 'zh') window.setDictType('zh');
      else if (curDictLang === 'en') window.setDictType('reader');
      else { closeDictDetail(); window.renderDict(); }
    } else {
      closeDictDetail();
      window.renderDict();
    }
  }
  if (id === 'study')   {
    window.renderStudyScreen().catch(e => console.error(e));
    // Update learn-later count badge on study screen
    updateLearnLaterBadges();
  }
  if (id === 'phrases') {
    // Always start with setup visible, toggle hidden (practice not yet running)
    const setup = document.getElementById('ph-setup-area');
    const toggle = document.getElementById('ph-setup-toggle');
    if (setup) setup.style.display = 'block';
    if (toggle) toggle.style.display = 'none';
    // Manual phrase adding is admin-only — hide the button for everyone else
    const genBtn = document.getElementById('ph-generate-btn');
    if (genBtn) genBtn.style.display = canEditSharedDictionary() ? '' : 'none';
    window.renderPhrasesScreen().catch(e => console.error(e));
  }
  if (id === 'numbers') renderNumbersScreen();
  if (id === 'groups')  { renderGroupsHome(VERBS); backToGroups(); }
  if (isFrKbEnabled()) {
    const kbMap = {trainer:'main', groups:'grp', phrases:'ph', numbers:'num'};
    if (kbMap[id]) setTimeout(() => showFrKb(kbMap[id]), 150);
  }
}

function updateBottomNav(id) {
  // Map screen ids to nav item ids
  const lang = globalThis.AN2_LANG || 'fr';
  const navMap = {
    home: 'bn-home',
    reader: 'bn-reader',
    dict: 'bn-dict',
    'zh-trainer': 'bn-dict',
    profile: 'bn-profile',
    'profile-user': 'bn-profile',
    trainer: 'bn-profile',
    study: 'bn-profile',
    phrases: 'bn-profile',
    grammar: 'bn-profile',
    stats: 'bn-profile',
    leaderboard: 'bn-profile',
  };
  document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
  const activeId = navMap[id];
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) el.classList.add('active');
  }
}

// ── Авторизация ──
export function loginProfile(name) {
  readerSwitchStorageOwner(isGuest ? 'guest' : ((typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null) || sbUser?.uid || sbUser?.id || name || 'anon'));
  currentProfile = setActiveProfileName(String(name || 'user').toLowerCase(), sbUser || null);
  const brand = document.querySelector('.nav-brand');
  if (brand) brand.innerHTML = 'Reader AI <span style="font-size:0.65rem;opacity:0.6;font-style:normal;margin-left:6px">' + name + '</span>';
  document.getElementById('screen-profile').style.display = 'none';
  document.getElementById('main-app').style.display = 'block';
  hideLoading();
  const addVerbBtn = document.getElementById('add-verb-btn');
  if (addVerbBtn) addVerbBtn.style.display = canEditSharedDictionary() ? 'inline-block' : 'none';
  refreshFirebaseAdminStatus().catch(() => {});
  startBackgroundSync();
  // These can throw if data isn't ready yet (e.g. empty cache on first cloud
  // load). A render error must NOT crash startup and dump the user back to a
  // scary "не запустилось" screen — the app shell is already usable.
  try { resetTrainer(); } catch (e) { console.warn('[login] resetTrainer skipped:', e?.message); }
  try { updateLangUI(); showScreen('home'); } catch (e) { console.warn('[login] showScreen skipped:', e?.message); }
}

// Guest mode: use the app without an account. Data lives in localStorage only.
// Generation and AI-checking are disabled (they cost money / are admin-only),
// but everything else — including TTS — works.
export async function continueAsGuest() {
  try {
    setIsGuest(true);
    localStorage.setItem('an2_guest', '1');
    currentProfile = 'guest';
    setCurrentProfile('guest');
    setSbUser(null);
    readerSwitchStorageOwner('guest');

    const brand = document.querySelector('.nav-brand');
    if (brand) brand.innerHTML = 'Reader AI <span style="font-size:0.65rem;opacity:0.6;font-style:normal;margin-left:6px">гость</span>';

    showLoading('Загружаем глаголы...');
    const verbsOk = await withDeadline(() => loadVerbsFromCloud(), CORE_LOAD_TIMEOUT_MS + 3000, 'Глаголы');
    if (!verbsOk || !VERBS_LOADED) throw new Error('Не удалось загрузить базу глаголов.');

    document.getElementById('screen-profile').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';
    applyGuestRestrictions();
    resetTrainer();
    showScreen('home');
    startPhrasesBackgroundLoad();
  } catch (e) {
    alert('Ошибка входа гостем: ' + getErrorMessage(e));
  } finally {
    hideLoading();
  }
}

// Hide features a guest can't use (generation, AI phrase check)
function applyGuestRestrictions() {
  if (!isGuest) return;
  const addVerbBtn = document.getElementById('add-verb-btn');
  if (addVerbBtn) addVerbBtn.style.display = 'none';
  // Generation buttons / AI-check are gated at call time too (guardGuest)
}
window.continueAsGuest = continueAsGuest;

// ── Diagnostics: connectivity self-test from the auth screen ──
// Проверяет именно Firebase Realtime Database — то, ради чего и переезжаем.
window.checkServerHealth = async function() {
  const btn = document.getElementById('health-btn');
  const out = document.getElementById('health-result');
  if (!out) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Проверяем...'; }
  out.style.display = 'block';
  out.style.background = 'var(--surface2)';
  out.style.color = 'var(--text-muted)';
  out.textContent = 'Запрос к Firebase...';
  const t0 = Date.now();
  try {
    if (typeof window.an2FirebaseHealth !== 'function') throw new Error('Firebase ещё не инициализирован. Проверь js/firebase-config.js.');
    const result = await withDeadline(() => window.an2FirebaseHealth(), 10000, 'Firebase');
    const ms = result?.ms ?? (Date.now() - t0);
    out.style.background = 'rgba(40,120,60,0.12)';
    out.style.color = 'var(--good)';
    out.textContent = `✓ Firebase отвечает (${ms} мс). Можно пробовать вход и загрузку глаголов.`;
  } catch (e) {
    const ms = Date.now() - t0;
    out.style.background = 'rgba(166,42,33,0.10)';
    out.style.color = 'var(--bad)';
    out.textContent = `✗ Нет связи с Firebase (${ms} мс): ${e.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📡 Проверить связь с Firebase'; }
  }
};

export function logoutProfile() {
  if (sbUser) { sbSignOut(); setSbUser(null); }
  setIsGuest(false);
  localStorage.removeItem('an2_guest');
  stopBackgroundSync();
  currentProfile = null; setCurrentProfile(null); try { window.an2CurrentProfileName = ''; } catch {}
  readerSwitchStorageOwner('anon');
  VERBS_LOADED = false;
  PHRASES_LOADED = false;
  VERBS.length = 0;
  PHRASES.length = 0;
  const brand = document.querySelector('.nav-brand');
  if (brand) brand.innerHTML = 'Reader AI';
  document.getElementById('main-app').style.display = 'none';
  document.getElementById('screen-profile').style.display = 'flex';
  const puEl = document.getElementById('screen-profile-user');
  if (puEl) puEl.style.display = 'none';
  switchAuthTab('login');
}

export function switchAuthTab(tab) {
  document.getElementById('auth-tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('auth-tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('auth-form-login').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('auth-form-register').style.display = tab === 'register' ? 'block' : 'none';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function hideAuthMessages() {
  ['auth-error','auth-success'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function normalizeLoginError(e) {
  const msg = getErrorMessage(e, 'Ошибка входа');
  if (msg.includes('Вход не ответил') || msg.includes('Сервер не ответил')) {
    return 'Firebase не ответил за минуту. Это не ошибка пароля: телефон не достучался до базы/авторизации. Проверь Wi‑Fi/4G/VPN и попробуй снова.';
  }
  return msg;
}

export async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showAuthError('Введите email и пароль'); return; }

  const btn = document.getElementById('login-btn');
  if (!isSupabaseReady()) {
    showAuthError('Firebase SDK/Auth не загрузился. Открой firebase-test.html и проверь вход. Если там ошибка auth/operation-not-allowed — включи Email/Password в Firebase Authentication.');
    return;
  }

  hideAuthMessages();
  btn.textContent = '⏳ Входим...';
  btn.disabled = true;

  try {
    // v68.8: вход больше НЕ блокируется загрузкой словаря/профиля/SRS.
    // Firebase Auth — единственный обязательный шаг. Всё остальное тянем фоном.
    const user = await withDeadline(() => sbSignIn(email, password), AUTH_TIMEOUT_MS, 'Вход');
    setSbUser(user);

    const cachedName = getCachedProfileName(user);
    const safeName = cachedName || email.split('@')[0] || 'user';
    currentProfile = setActiveProfileName(safeName, user);

    // Если локального кэша нет — это нормально: v68 перешёл на пустые личные базы.
    // Не заставляем пользователя смотреть на экран регистрации из-за пустого /userdict.
    if (!restoreVerbsFromCache()) {
      VERBS.length = 0;
      VERBS_LOADED = true;
      saveCache(VERBS_CACHE_KEY, VERBS);
    }

    loginProfile(currentProfile);
    startPhrasesBackgroundLoad();
    showToast('✅ Вход выполнен');

    // Фоновая синхронизация: профиль, личный словарь, статистика, SRS, книги.
    (async () => {
      try {
        const profile = await ensureProfileForUser(user, email);
        if (profile?.username) {
          currentProfile = setActiveProfileName(profile.username, user);
          const brand = document.querySelector('.nav-brand');
          if (brand) brand.innerHTML = 'Reader AI <span style="font-size:0.65rem;opacity:0.6;font-style:normal;margin-left:6px">' + currentProfile + '</span>';
        }
        const [verbsOk, cloudStats, cloudSRS, cloudMeta] = await Promise.all([
          runOptional('Глаголы (фон)', () => loadVerbsFromCloud({ force: true }), CORE_LOAD_TIMEOUT_MS + 3000),
          runOptional('Статистика', () => sbLoadStats()),
          runOptional('SRS', () => sbLoadSRS()),
          runOptional('Meta', () => sbLoadMeta()),
        ]);
        applyCloudProgress(cloudStats, cloudSRS, cloudMeta, { mergeStats: true });
        flushFailedSync().catch(() => {});
        try {
          await loadReaderBooksFromCloud(true);
          if (document.getElementById('screen-home')?.classList.contains('active')) renderHome();
        } catch {}
        syncWordStateFromCloud().catch(() => {});
        if (!verbsOk) console.warn('[login-bg] verbs refresh skipped');
      } catch (e) {
        console.warn('[login-bg] cloud sync skipped:', getErrorMessage(e));
      }
    })();
  } catch(e) {
    showAuthError(normalizeLoginError(e));
  } finally {
    btn.textContent = 'Войти';
    btn.disabled = false;
    hideLoading();
  }
}

export async function doRegister() {
  const email = document.getElementById('reg-email')?.value.trim() || '';
  const password = document.getElementById('reg-password')?.value || '';
  const username = document.getElementById('reg-username')?.value.trim() || '';
  if (!email || !password || !username) { showAuthError('Заполни все поля'); return; }
  if (!isSupabaseReady()) {
    showAuthError('Firebase SDK/Auth не загрузился. Открой firebase-test.html и проверь вход/регистрацию. Если там auth/operation-not-allowed — включи Email/Password в Firebase Authentication.');
    return;
  }

  // v68.9: раньше JS искал #register-btn, а в HTML была кнопка #reg-btn.
  // Из-за null.textContent регистрация падала ДО try/catch и экран входа
  // выглядел «застрявшим». Держим оба id, чтобы больше не ловить эту крысу.
  const btn = document.getElementById('register-btn') || document.getElementById('reg-btn');
  hideAuthMessages();
  if (btn) {
    btn.textContent = '⏳ Регистрируем...';
    btn.disabled = true;
  }

  try {
    // v68.8: регистрация сразу вводит в приложение. Firebase createUser уже создаёт сессию,
    // поэтому не оставляем пользователя висеть на вкладке регистрации.
    const user = await withDeadline(() => sbSignUp(email, password, username), AUTH_TIMEOUT_MS, 'Регистрация');
    setSbUser(user);
    currentProfile = setActiveProfileName(username || email.split('@')[0] || 'user', user);

    VERBS.length = 0;
    VERBS_LOADED = true;
    saveCache(VERBS_CACHE_KEY, VERBS);

    loginProfile(currentProfile);
    startPhrasesBackgroundLoad();
    showToast(user?.profileWriteError ? '✅ Аккаунт создан. Профиль дозапишется позже.' : '✅ Аккаунт создан, вход выполнен');

    (async () => {
      try {
        await ensureProfileForUser(user, email);
        await Promise.all([
          runOptional('Глаголы (фон)', () => loadVerbsFromCloud({ force: true }), CORE_LOAD_TIMEOUT_MS + 3000),
          runOptional('Статистика', () => sbLoadStats()),
          runOptional('SRS', () => sbLoadSRS()),
          runOptional('Meta', () => sbLoadMeta()),
        ]);
        try { await loadReaderBooksFromCloud(true); } catch {}
      } catch (e) {
        console.warn('[register-bg] cloud init skipped:', getErrorMessage(e));
      }
    })();
  } catch(e) {
    showAuthError(getErrorMessage(e, 'Ошибка регистрации'));
  } finally {
    if (btn) {
      btn.textContent = 'Создать аккаунт';
      btn.disabled = false;
    }
    hideLoading();
  }
}

// ── Стрик ──
export function updateStreak() {
  const m = loadMeta();
  const today = new Date().toDateString();
  if (m.lastDay === today) return;
  const d = new Date(); d.setDate(d.getDate() - 1);
  const yesterday = d.toDateString();
  if (m.lastDay === yesterday) m.streak = (m.streak || 0) + 1;
  else m.streak = 1;
  m.bestStreak = Math.max(m.bestStreak || 0, m.streak);
  m.lastDay = today;
  saveMeta(m);
}

// ── Тренажёр ──
export function resetTrainer() {
  const reviewBanner = document.getElementById('review-banner');
  if (reviewBanner) reviewBanner.classList.toggle('active', reviewMode);
  const ok = pickCard(VERBS);
  if (!ok) {
    // SRS session finished — all due verbs cleared
    if (isSrsSessionActive()) {
      showSrsComplete();
      endSrsSession();
      return;
    }
    if (reviewMode) showNoWeakState();
    return;
  }
  hideNoWeakState();
  renderCard(frKbEnabled, showFrKb);
  clearFeedback();
}

function showSrsComplete() {
  // Hide the card and input WITHOUT destroying them; show a separate panel.
  const card = document.getElementById('trainer-card');
  const noWeak = document.getElementById('no-weak-state');
  const complete = document.getElementById('srs-complete-state');
  const typeArea = document.getElementById('type-area');
  const feedbackRow = document.getElementById('feedback-row');
  const scoreRow = document.getElementById('score-row');
  if (card) card.style.display = 'none';
  if (noWeak) noWeak.style.display = 'none';
  if (typeArea) typeArea.style.display = 'none';
  if (feedbackRow) feedbackRow.style.display = 'none';
  if (complete) complete.style.display = 'flex';
  const formBar = document.getElementById('srs-form-bar');
  if (formBar) formBar.style.display = 'none';
  const reviewBanner = document.getElementById('review-banner');
  if (reviewBanner) reviewBanner.classList.remove('active');
}

// Restore the normal trainer UI (card + input) after a completion screen
function restoreTrainerUI() {
  const card = document.getElementById('trainer-card');
  const complete = document.getElementById('srs-complete-state');
  const typeArea = document.getElementById('type-area');
  const feedbackRow = document.getElementById('feedback-row');
  if (complete) complete.style.display = 'none';
  if (card) card.style.display = '';
  if (typeArea) typeArea.style.display = '';
  if (feedbackRow) feedbackRow.style.display = '';
  // Form bar only belongs to SRS sessions; hide it in normal trainer
  const formBar = document.getElementById('srs-form-bar');
  if (formBar && !isSrsSessionActive()) formBar.style.display = 'none';
}

function showNoWeakState() {
  document.getElementById('trainer-card').style.display = 'none';
  document.getElementById('no-weak-state').style.display = 'flex';
  document.getElementById('type-area').style.display = 'none';
  document.getElementById('recall-area').style.display = 'none';
  document.getElementById('feedback-row').style.display = 'none';
}

function hideNoWeakState() {
  document.getElementById('trainer-card').style.display = '';
  document.getElementById('no-weak-state').style.display = 'none';
  document.getElementById('type-area').style.display = '';
  document.getElementById('feedback-row').style.display = '';
}

// ── Фоновая синхронизация ──
let bgSyncInterval = null;
function startBackgroundSync() {
  if (bgSyncInterval) return;
  bgSyncInterval = setInterval(async () => {
    if (sbUser && currentProfile) await syncStatsFromCloud();
  }, 60000);
}
function stopBackgroundSync() {
  if (bgSyncInterval) { clearInterval(bgSyncInterval); bgSyncInterval = null; }
}

// ── Инициализация ──
async function init() {
  showLoading('Reader AI — запуск...');
  initSpeech();
  applyKbMode();
  initTTSEngineUI();

  // The Firebase SDK loads from a CDN and sometimes isn't ready when init runs
  // (this caused the "works every other time" symptom). Retry a few times
  // before falling back to the auth screen.
  let supabaseOk = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    supabaseOk = initSupabase();
    if (supabaseOk && isSupabaseReady()) break;
    await new Promise(r => setTimeout(r, 300)); // wait for window.firebase to appear
  }

  if (!supabaseOk || !isSupabaseReady()) {
    console.warn('[init] Firebase SDK never loaded; offering guest + retry');
    hideLoading();
    const profileScreen = document.getElementById('screen-profile');
    if (profileScreen) profileScreen.style.display = 'flex';
    switchAuthTab('login');
    showAuthError('Не удалось загрузить Firebase SDK или конфиг. Проверь js/firebase-config.js, обнови страницу или войди гостем.');
    return;
  }

  // ── INSTANT SESSION RESTORE ──
  // Firebase SDK сам хранит сессию, но оставляем быстрый compat-restore из localStorage
  // плюс fallback через sb.auth.getSession(), чтобы перезагрузка не превращалась в рулетку.
  const SB_SESSION_KEY = 'sb-dhimxbkjvowmwrosgcpb-auth-token';
  let data = { session: null };
  try {
    const raw = localStorage.getItem(SB_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const session = parsed?.currentSession || parsed;
      if (session?.access_token && session?.user) {
        const expires = session.expires_at || 0;
        const nowSec = Math.floor(Date.now() / 1000);
        if (expires === 0 || expires > nowSec - 60) {
          // Token valid (or expiry unknown) — use it directly
          data = { session };
          // Silently refresh in background if expiring soon (no await — non-blocking)
          if (expires > 0 && expires - nowSec < 600) {
            sb.auth.refreshSession().catch(() => {});
          }
        } else {
          // Token expired — clear it so the user sees the login screen
          console.log('[init] stored session expired, clearing');
          localStorage.removeItem(SB_SESSION_KEY);
        }
      }
    }
  } catch (e) {
    console.warn('[init] localStorage session read failed:', getErrorMessage(e));
    // Fall through to show login screen
  }

  if (!data.session) {
    try {
      const restored = await withDeadline(() => sb.auth.getSession(), 3500, 'Восстановление Firebase-сессии');
      if (restored?.data?.session) data = restored.data;
    } catch (e) {
      console.warn('[init] Firebase session restore skipped:', getErrorMessage(e));
    }
  }

  console.log('[init] session from localStorage/firebase:', !!data.session, '| guest flag:', localStorage.getItem('an2_guest'));

  if (data.session) {
    // v68.8: восстановление сессии тоже не блокируется словарём/профилем.
    // Если Firebase Auth вернул пользователя — сразу показываем приложение.
    setSbUser(data.session.user);
    const email = data.session.user.email || '';
    const cachedName = getCachedProfileName(data.session.user);
    currentProfile = setActiveProfileName(cachedName || email.split('@')[0] || 'user', data.session.user);

    if (!restoreVerbsFromCache()) {
      VERBS.length = 0;
      VERBS_LOADED = true;
      saveCache(VERBS_CACHE_KEY, VERBS);
    }

    loginProfile(currentProfile);
    startPhrasesBackgroundLoad();

    (async () => {
      try {
        const profile = await ensureProfileForUser(data.session.user, email);
        if (profile?.username) {
          currentProfile = setActiveProfileName(profile.username, user);
          const brand = document.querySelector('.nav-brand');
          if (brand) brand.innerHTML = 'Reader AI <span style="font-size:0.65rem;opacity:0.6;font-style:normal;margin-left:6px">' + currentProfile + '</span>';
        }
        const [verbsOk, cloudStats, cloudSRS, cloudMeta] = await Promise.all([
          runOptional('Глаголы (фон)', () => loadVerbsFromCloud({ force: true }), CORE_LOAD_TIMEOUT_MS + 3000),
          runOptional('Статистика', () => sbLoadStats()),
          runOptional('SRS', () => sbLoadSRS()),
          runOptional('Meta', () => sbLoadMeta()),
        ]);
        applyCloudProgress(cloudStats, cloudSRS, cloudMeta, { mergeStats: true });
        try {
          await loadReaderBooksFromCloud(true);
          if (document.getElementById('screen-home')?.classList.contains('active')) renderHome();
        } catch {}
        syncWordStateFromCloud().catch(() => {});
        if (!verbsOk) console.warn('[restore-bg] verbs refresh skipped');
      } catch (e) {
        console.warn('[restore-bg] cloud sync skipped:', getErrorMessage(e));
      }
    })();
    return;
  }

  const guestFlag = localStorage.getItem('an2_guest');
  if (guestFlag === '1') {
    try {
      await continueAsGuest();
      return;
    } catch (e) {
      alert('Гость-автовход упал: ' + getErrorMessage(e));
    }
  }

  hideLoading();
  document.getElementById('screen-profile').style.display = 'flex';
  switchAuthTab('login');
}

// Start app
init().catch((e) => {
  console.error('[init] fatal:', e);
  hideLoading();
  const profileScreen = document.getElementById('screen-profile');
  if (profileScreen) profileScreen.style.display = 'flex';
  try { switchAuthTab('login'); } catch (_) {}
  // Show the REAL error text — guessing blind has wasted enough time.
  const msg = (e && (e.message || e.toString())) || 'неизвестная ошибка';
  showAuthError('Сбой запуска: ' + msg);
});

// ── Verb Picker ──
function openVerbPicker() {
  document.getElementById('verb-picker-modal').style.display = 'flex';
  document.getElementById('vp-search').value = '';
  document.querySelectorAll('.vp-filter').forEach((b,i) => b.classList.toggle('active', i === 0));
  renderVerbPicker(VERBS);
}

function closeVerbPicker() {
  document.getElementById('verb-picker-modal').style.display = 'none';
}

function applyVerbSelection() {
  if (selectedVerbIds.size === 0) { closeVerbPicker(); return; }
  closeVerbPicker();

  // Copy selected IDs to trainer's selectedVerbIds
  trainerSelectedVerbIds.clear();
  selectedVerbIds.forEach(id => trainerSelectedVerbIds.add(id));

  const banner = document.getElementById('custom-selection-banner');
  const n = selectedVerbIds.size;
  if (banner) banner.style.display = 'flex';
  const label = document.getElementById('custom-selection-label');
  if (label) label.textContent = `📋 Тренировка: ${n} глагол${n===1?'':n<5?'а':'ов'} выбрано`;
  resetTrainer();
}

function clearVerbSelection() {
  selectedVerbIds.clear();
  trainerSelectedVerbIds.clear();
  const banner = document.getElementById('custom-selection-banner');
  if (banner) banner.style.display = 'none';
  resetTrainer();
}

// ── Add Verb Modal ──
function setVerbFormField(id, forms) {
  const el = document.getElementById(id);
  if (el) el.value = Array.isArray(forms) ? forms.join(', ') : '';
}

function resetAddVerbModalFields() {
  [
    'add-verb-input','add-verb-meaning','add-verb-pp','add-verb-example',
    'add-verb-present','add-verb-imparfait','add-verb-futur',
    'add-verb-plus_que_parfait','add-verb-conditionnel','add-verb-subjonctif','add-verb-imperatif','add-verb-passe_simple'
  ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const group = document.getElementById('add-verb-group'); if (group) group.value = 'irr';
  const aux = document.getElementById('add-verb-aux'); if (aux) aux.value = 'avoir';
}

function showAddVerbModal(editId = null) {
  if (window.guardGuest && window.guardGuest(editId ? 'Редактирование глагола' : 'Добавление глагола')) return;
  if (!canEditSharedDictionary()) { showToast('🔒 Доступно только администратору'); return; }

  const modal = document.getElementById('add-verb-modal');
  if (!modal) return;
  modal.dataset.editId = editId || '';
  resetAddVerbModalFields();

  const title = document.getElementById('add-verb-title');
  const confirm = document.getElementById('add-verb-confirm');
  if (title) title.textContent = editId ? '✏️ Редактировать глагол' : '➕ Добавить глагол вручную';
  if (confirm) confirm.textContent = editId ? 'Сохранить изменения' : 'Сохранить';

  if (editId) {
    const v = VERBS.find(x => String(x.id) === String(editId));
    if (!v) { showToast('⚠️ Глагол не найден'); return; }
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('add-verb-input', v.inf || v.id || '');
    set('add-verb-meaning', v.meaning || '');
    const group = document.getElementById('add-verb-group'); if (group) group.value = v.group || v.group_name || 'irr';
    const aux = document.getElementById('add-verb-aux'); if (aux) aux.value = v.aux === 'être' ? 'être' : 'avoir';
    set('add-verb-pp', v.pp || '');
    set('add-verb-example', v.ex?.present || '');
    setVerbFormField('add-verb-present', v.conj?.present || []);
    setVerbFormField('add-verb-imparfait', v.conj?.imparfait || []);
    setVerbFormField('add-verb-futur', v.conj?.futur || []);
    setVerbFormField('add-verb-plus_que_parfait', v.conj?.plus_que_parfait || []);
    setVerbFormField('add-verb-conditionnel', v.conj?.conditionnel || []);
    setVerbFormField('add-verb-subjonctif', v.conj?.subjonctif || []);
    setVerbFormField('add-verb-imperatif', v.conj?.imperatif || []);
    setVerbFormField('add-verb-passe_simple', v.conj?.passe_simple || []);
  }

  const status = document.getElementById('add-verb-status');
  if (status) { status.style.display = 'none'; status.textContent = ''; }
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('add-verb-input')?.focus(), 100);
}

function closeAddVerbModal() {
  const modal = document.getElementById('add-verb-modal');
  if (modal) { modal.style.display = 'none'; modal.dataset.editId = ''; }
  const status = document.getElementById('add-verb-status');
  if (status) { status.style.display = 'none'; }
}

function normalizeManualVerbFormLine(line) {
  return String(line || '')
    .trim()
    .replace(/^j[’']\s*/i, '')
    .replace(/^(je|tu|il\/elle|ils\/elles|il|elle|on|nous|vous|ils|elles)\s+/i, '')
    .trim();
}

function parseManualVerbForms(raw, label, required = false, expected = 6) {
  const text = String(raw || '').trim();
  if (!text) {
    if (required) throw new Error(`Заполни ${label}: нужно 6 форм.`);
    return [];
  }
  const parts = text
    .split(/[\n;,]+/)
    .map(normalizeManualVerbFormLine)
    .filter(Boolean);
  if (parts.length !== expected) {
    throw new Error(`${label}: нужно ровно ${expected} форм. Сейчас: ${parts.length}.`);
  }
  return parts;
}

function normalizeVerbId(inf) {
  return String(inf || '')
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, '_')
    .replace(/[.#$\[\]\/]/g, '_');
}

function makeFrenchSubjectPhrase(pronoun, form) {
  const p = String(pronoun || '').trim();
  const f = String(form || '').trim();
  if (!p) return f;
  if (!f) return p;
  const spokenPronoun = p === 'il/elle' ? 'il' : (p === 'ils/elles' ? 'ils' : p);
  if (/^je$/i.test(spokenPronoun) && /^[aeiouhàâäéèêëîïôöùûü]/i.test(f)) return `j'${f}`;
  return `${spokenPronoun} ${f}`;
}

async function addVerb() {
  const modal = document.getElementById('add-verb-modal');
  const editId = modal?.dataset.editId || '';
  const existing = editId ? VERBS.find(v => String(v.id) === String(editId)) : null;

  const infinitive = document.getElementById('add-verb-input')?.value.trim().toLowerCase();
  const meaning = document.getElementById('add-verb-meaning')?.value.trim() || '';
  const group = document.getElementById('add-verb-group')?.value || 'irr';
  const aux = document.getElementById('add-verb-aux')?.value === 'être' ? 'être' : 'avoir';
  const pp = document.getElementById('add-verb-pp')?.value.trim().toLowerCase() || '';
  const example = document.getElementById('add-verb-example')?.value.trim() || '';

  if (!infinitive) { alert('Введи инфинитив'); return; }
  if (!meaning) { alert('Введи перевод'); return; }

  const btn = document.getElementById('add-verb-confirm');
  const status = document.getElementById('add-verb-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Сохраняю...'; }
  if (status) {
    status.style.display = 'block'; status.style.color = 'var(--accent)';
    status.textContent = editId ? '⏳ Обновляю глагол в Firebase...' : '⏳ Сохраняю глагол в Firebase...';
  }

  try {
    const present = parseManualVerbForms(document.getElementById('add-verb-present')?.value, 'Présent', true);
    const imparfait = parseManualVerbForms(document.getElementById('add-verb-imparfait')?.value, 'Imparfait', false);
    const futur = parseManualVerbForms(document.getElementById('add-verb-futur')?.value, 'Futur', false);
    const plusQueParfait = parseManualVerbForms(document.getElementById('add-verb-plus_que_parfait')?.value, 'Plus-que-parfait', false);
    const conditionnel = parseManualVerbForms(document.getElementById('add-verb-conditionnel')?.value, 'Conditionnel', false);
    const subjonctif = parseManualVerbForms(document.getElementById('add-verb-subjonctif')?.value, 'Subjonctif', false);
    const imperatif = parseManualVerbForms(document.getElementById('add-verb-imperatif')?.value, 'Impératif', false, 3);
    const passeSimple = parseManualVerbForms(document.getElementById('add-verb-passe_simple')?.value, 'Passé simple', false);

    const id = normalizeVerbId(infinitive);
    const now = new Date().toISOString();
    const ex = { ...(existing?.ex || {}) };
    const verb = {
      ...(existing || {}),
      id,
      inf: infinitive,
      meaning,
      group,
      group_name: group,
      aux,
      pp,
      custom: true,
      created_at: existing?.created_at || now,
      updated_at: now,
      conj: { present },
      ex,
    };

    if (example) verb.ex.present = example;
    else if (!verb.ex.present) verb.ex.present = `${makeFrenchSubjectPhrase('je', present[0])}.`;

    const setOptionalTense = (key, forms, exampleBuilder) => {
      if (forms.length) {
        verb.conj[key] = forms;
        verb.ex[key] = verb.ex[key] || exampleBuilder(forms);
      } else {
        delete verb.conj[key];
        delete verb.ex[key];
      }
    };

    setOptionalTense('imparfait', imparfait, f => `${makeFrenchSubjectPhrase('je', f[0])}.`);
    setOptionalTense('futur', futur, f => `${makeFrenchSubjectPhrase('je', f[0])}.`);
    setOptionalTense('plus_que_parfait', plusQueParfait, f => `${makeFrenchSubjectPhrase('je', f[0])}.`);
    setOptionalTense('conditionnel', conditionnel, f => `${makeFrenchSubjectPhrase('je', f[0])}.`);
    setOptionalTense('subjonctif', subjonctif, f => `Il faut que je ${f[0]}.`);
    setOptionalTense('imperatif', imperatif, f => `${f[0]} !`);
    setOptionalTense('passe_simple', passeSimple, f => `${makeFrenchSubjectPhrase('je', f[0])}.`);

    if (pp) verb.ex.passe = verb.ex.passe || (aux === 'être' ? `Je suis ${pp}.` : `J'ai ${pp}.`);
    else delete verb.ex.passe;

    const { error } = await sb.from('verbs').upsert(verb);
    if (error) throw error;

    if (editId && editId !== id) {
      const del = await sb.from('verbs').delete().eq('id', editId);
      if (del.error) console.warn('[verb edit] old key cleanup failed:', del.error.message);
    }

    if (status) {
      status.style.color = 'var(--good)';
      status.textContent = editId ? `✅ «${infinitive}» обновлён.` : `✅ «${infinitive}» сохранён в Firebase.`;
    }

    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('an2_cache_verbs')) localStorage.removeItem(k);
      });
    } catch {}

    VERBS_LOADED = false;
    await loadVerbsFromCloud({ force: true });
    if (typeof window.renderDict === 'function') window.renderDict();
    setTimeout(() => { closeAddVerbModal(); window.renderStudyScreen?.(); }, 700);
  } catch(e) {
    if (status) {
      status.style.color = 'var(--bad)';
      status.textContent = '❌ ' + (e?.message || e);
    } else {
      showToast('⚠️ ' + (e?.message || e));
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = editId ? 'Сохранить изменения' : 'Сохранить'; }
  }
}

// ── Study helpers ──
function goToTrainerFromStudy() {
  showScreen('trainer');
  resetTrainer();
}

// Signal proxy that module is ready

// ── More menu ──
export function toggleMoreMenu() {
  const menu = document.getElementById('more-menu');
  const overlay = document.getElementById('more-overlay');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  if (overlay) overlay.style.display = isOpen ? 'none' : 'block';
}

export function closeMoreMenu() {
  const menu = document.getElementById('more-menu');
  const overlay = document.getElementById('more-overlay');
  if (menu) menu.style.display = 'none';
  if (overlay) overlay.style.display = 'none';
}

export function showProfileManage() {
  const uid = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
  if (uid && !isGuest) {
    document.getElementById('main-app').style.display = 'block';
    showScreen('profile-user');
    renderUserProfile();
    return;
  }
  document.getElementById('main-app').style.display = 'none';
  const el = document.getElementById('screen-profile');
  if (el) { el.style.display = 'flex'; switchAuthTab('login'); }
}

function renderUserProfile() {
  const uid = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
  const user = sbUser;

  const name = currentProfile || user?.displayName || user?.email?.split('@')[0] || 'U';
  const avatarEl = document.getElementById('pu-avatar');
  if (avatarEl) avatarEl.textContent = String(name).charAt(0).toUpperCase();

  const nameEl = document.getElementById('pu-name');
  if (nameEl) nameEl.textContent = currentProfile || user?.displayName || name;
  const emailEl = document.getElementById('pu-email');
  if (emailEl) emailEl.textContent = user?.email || '';

  const state = loadReaderWordState();
  const entries = Object.values(state || {});
  const saved = entries.filter(e => e?.saved).length;
  const known = entries.filter(e => e?.known || e?.status === 'known').length;
  const seen = entries.filter(e => (e?.seen || 0) > 0 || (e?.clicked || 0) > 0).length;
  const statsEl = document.getElementById('pu-stats');
  if (statsEl) {
    statsEl.innerHTML = [
      [saved, 'Сохранено', 'var(--blue)'],
      [known, 'Знаю', 'var(--text-muted)'],
      [seen, 'Встречено', 'var(--accent)'],
    ].map(([n, label, color]) => `
      <div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:8px;">
        <div style="font-size:1.4rem;font-weight:700;color:${color}">${n}</div>
        <div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px">${label}</div>
      </div>
    `).join('');
  }

  const langMeta = READER_LANG_META[readerCanonicalLang(globalThis.AN2_LANG || 'fr')];
  const langEl = document.getElementById('pu-lang');
  if (langEl) langEl.textContent = (langMeta?.emoji ? langMeta.emoji + ' ' : '') + (langMeta?.label || 'Français');

  const syncEl = document.getElementById('pu-sync-status');
  if (syncEl) syncEl.textContent = uid ? 'Прогресс слов сохраняется в облаке' : 'Войдите для синхронизации';
}

async function syncWordStateNow() {
  const btn = document.querySelector('[onclick="window.syncWordStateNow?.()"]');
  if (btn) btn.textContent = '⏳ Синхронизация...';
  try {
    await syncWordStateToCloud();
    await syncWordStateFromCloud();
    if (btn) btn.textContent = '✅ Готово';
    setTimeout(() => { if (btn) btn.textContent = '☁️ Синхронизировать сейчас'; }, 2000);
  } catch (e) {
    if (btn) btn.textContent = '❌ Ошибка';
    setTimeout(() => { if (btn) btn.textContent = '☁️ Синхронизировать сейчас'; }, 2000);
  }
}

// ── Leaderboard ──
export async function renderLeaderboard() {
  const loadingEl = document.getElementById('leaderboard-loading');
  const listEl = document.getElementById('leaderboard-list');
  if (loadingEl) loadingEl.style.display = 'block';
  if (listEl) listEl.style.display = 'none';
  try {
    const { data, error } = await sb.from('stats').select('user_id, total, correct');
    if (error) throw error;
    const byUser = {};
    (data || []).forEach(r => {
      if (!byUser[r.user_id]) byUser[r.user_id] = { total: 0, correct: 0 };
      byUser[r.user_id].total += r.total || 0;
      byUser[r.user_id].correct += r.correct || 0;
    });
    const { data: profiles } = await sb.from('profiles').select('id, username');
    const nameMap = {};
    (profiles || []).forEach(p => { nameMap[p.id] = p.username; });
    const sorted = Object.entries(byUser)
      .map(([id, s]) => ({ name: nameMap[id] || id.slice(0, 8), ...s, pct: s.total > 0 ? Math.round(s.correct / s.total * 100) : 0 }))
      .sort((a, b) => b.total - a.total);
    if (listEl) {
      listEl.style.display = 'block';
      listEl.innerHTML = sorted.length === 0
        ? '<div style="color:var(--text-muted);text-align:center;padding:20px">Нет данных</div>'
        : sorted.map((u, i) => `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:8px"><div style="font-size:1.2rem;min-width:28px">${i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`}</div><div style="flex:1"><div style="font-weight:500">${u.name}</div><div style="font-size:0.75rem;color:var(--text-muted)">${u.total} попыток · ${u.pct}% точность</div></div></div>`).join('');
    }
  } catch(e) {
    if (listEl) { listEl.style.display = 'block'; listEl.innerHTML = '<div style="color:var(--bad);padding:20px;text-align:center">Ошибка загрузки</div>'; }
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

// ── Grammar ──
export function setGrammar(tense) {
  document.querySelectorAll('.grammar-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.grammar-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('grammar-' + tense);
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.grammar-btn').forEach(b => {
    if (b.getAttribute('onclick')?.includes(`'${tense}'`)) b.classList.add('active');
  });
}

export function openGrammar(tense) {
  showScreen('grammar');
  setGrammar(tense);
}

// ── Trainer mode ──
export function setTrainerMode(mode) {
  // Hide ALL mode panels including verbs
  ['trainer-verbs-mode','trainer-nouns-mode','trainer-preps-mode','trainer-numbers-mode'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Update tab buttons style
  const btnMap = {verbs:'mode-verbs-btn', nouns:'mode-nouns-btn', preps:'mode-preps-btn', numbers:'mode-nums-btn'};
  Object.entries(btnMap).forEach(([m, btnId]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (m === mode) { btn.style.background = 'var(--accent)'; btn.style.color = '#f5ecd8'; }
    else { btn.style.background = 'none'; btn.style.color = 'var(--text-muted)'; }
  });

  showScreen('trainer');

  if (mode === 'verbs') {
    const el = document.getElementById('trainer-verbs-mode');
    if (el) el.style.display = 'block';
    resetTrainer();
  } else if (mode === 'nouns') {
    const el = document.getElementById('trainer-nouns-mode');
    if (el) el.style.display = 'block';
    window.nounNextCard?.();
  } else if (mode === 'preps') {
    const el = document.getElementById('trainer-preps-mode');
    if (el) el.style.display = 'block';
    window.prepNextCard?.();
  } else if (mode === 'numbers') {
    const el = document.getElementById('trainer-numbers-mode');
    if (el) el.style.display = 'block';
    window.nextNumber?.();
  }
}

// ── Keyboard handler ──
export function handleKey(event) {
  if (event.key === 'Enter') window.checkAnswer?.();
}

// ── SRS Review ──
export function startSRSReview() {
  // Check the queue FIRST — before navigating anywhere
  const srs = loadSRS();
  const today = todayStr();
  // Each due card is a verb+tense pair, e.g. "etre|present"
  const dueKeys = [];
  for (const v of VERBS) {
    for (const t of SRS_TENSES) {
      const c = srs[srsKey(v.id, t)];
      if (c && toDateStr(c.dueDate) <= today) dueKeys.push(srsKey(v.id, t));
    }
  }

  if (dueKeys.length === 0) {
    // Nothing due — stay on current screen, show a friendly toast
    showToast('✅ На сегодня повторений нет — загляни позже!');
    return;
  }

  // There ARE verbs to review → go to trainer
  // IMPORTANT: start the session BEFORE setTrainerMode/resetTrainer,
  // because setTrainerMode('verbs') calls resetTrainer() which calls pickCard().
  // If the session isn't active yet, pickCard picks a RANDOM verb instead of the queue.

  // Clear any manual verb selection so it doesn't interfere with the SRS session
  trainerSelectedVerbIds.clear();
  const banner = document.getElementById('custom-selection-banner');
  if (banner) banner.style.display = 'none';

  // Start the finite session FIRST
  startSrsSession(dueKeys);

  // Now navigate and render — pickCard will see the active session
  showScreen('trainer');
  restoreTrainerUI(); // clear any leftover completion screen

  const reviewBanner = document.getElementById('review-banner');
  if (reviewBanner) reviewBanner.classList.add('active');

  // Show verbs mode panel WITHOUT calling resetTrainer prematurely
  ['trainer-nouns-mode','trainer-preps-mode','trainer-numbers-mode'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  const verbsPanel = document.getElementById('trainer-verbs-mode');
  if (verbsPanel) verbsPanel.style.display = 'block';
  const vbtn = document.getElementById('mode-verbs-btn');
  if (vbtn) { vbtn.style.background = 'var(--accent)'; vbtn.style.color = '#f5ecd8'; }

  // Make sure trainer-card is restored (in case it showed completion before)
  const fb = document.getElementById('feedback-row');
  if (fb) fb.style.display = '';

  // Render the first card from the session queue
  resetTrainer();
}

// ── Переключение языка ──
function setAppLang(lang) {
  const allowed = ['fr', 'zh', 'en'];
  if (!allowed.includes(lang)) return;
  globalThis.AN2_LANG = lang;
  try { localStorage.setItem('an2_lang', lang); } catch {}
  updateLangUI();
  // Reset dict to correct type for new language
  if (typeof window.setDictType === 'function') {
    const dictScreenActive = document.getElementById('screen-dict')?.classList.contains('active');
    const targetDictType = lang === 'zh' ? 'zh' : lang === 'en' ? 'reader' : 'verbs';
    if (dictScreenActive) {
      window.setDictType(targetDictType);
    } else {
      // Reset tab visibility quietly so next open starts correctly
      const tabsFr = document.getElementById('dict-tabs-fr');
      const tabsZh = document.getElementById('dict-tabs-zh');
      if (tabsFr) tabsFr.style.display = (lang === 'zh' || lang === 'en') ? 'none' : 'flex';
      if (tabsZh) tabsZh.style.display = lang === 'zh' ? 'block' : 'none';
    }
  }
  // Re-render home if active
  if (document.getElementById('screen-home')?.classList.contains('active')) {
    Promise.resolve(renderHome()).catch(e => console.error(e));
  }
}

function updateLangUI() {
  const lang = globalThis.AN2_LANG || 'fr';
  const isZh = lang === 'zh';
  const isEn = lang === 'en';

  // Topbar buttons
  const btnFr = document.getElementById('hlb-fr');
  const btnEn = document.getElementById('hlb-en');
  const btnZh = document.getElementById('hlb-zh');
  if (btnFr) btnFr.classList.toggle('active', lang === 'fr');
  if (btnEn) btnEn.classList.toggle('active', isEn);
  if (btnZh) btnZh.classList.toggle('active', isZh);

  // 4th nav button
  const icon = document.getElementById('bn-practice-icon');
  const label = document.getElementById('bn-practice-label');
  if (icon) icon.textContent = isZh ? '🀄' : '⚡';
  if (label) label.textContent = isZh ? 'Символы' : 'Глаголы';

  // Sync dict tabs visibility without triggering a render
  const tabsFr = document.getElementById('dict-tabs-fr');
  const tabsZh = document.getElementById('dict-tabs-zh');
  if (tabsFr) tabsFr.style.display = (isZh || isEn) ? 'none' : 'flex';
  if (tabsZh) tabsZh.style.display = isZh ? 'block' : 'none';

  // Also sync import modal lang selector if open
  const importLangSel = document.getElementById('reader-import-lang');
  if (importLangSel && !importLangSel.dataset.userChanged) importLangSel.value = lang;
}

// 4th nav button action — depends on current lang
function navPracticeBtn() {
  const lang = globalThis.AN2_LANG || 'fr';
  if (lang === 'zh') {
    showScreen('zh-trainer');
  } else {
    showScreen('trainer');
  }
}

// Expose to window (override proxy stubs)
window.toggleMoreMenu       = toggleMoreMenu;
window.closeMoreMenu        = closeMoreMenu;
window.setAppLang           = setAppLang;
window.navPracticeBtn       = navPracticeBtn;
window.updateLangUI         = updateLangUI;
window.showProfileManage    = showProfileManage;
window.renderUserProfile    = renderUserProfile;
window.syncWordStateNow     = syncWordStateNow;
window.renderLeaderboard    = renderLeaderboard;
window.setGrammar           = setGrammar;
window.openGrammar          = openGrammar;
window.setTrainerMode       = setTrainerMode;
window.handleKey            = handleKey;
window.startSRSReview       = startSRSReview;
window.goToTrainerFromStudy = goToTrainerFromStudy;
function getConjugationRule(verb, tense) {
  if (!verb) return 'Выбери глагол';
  const g = verb.group; // 'er' | 'ir' | 're' | 'irr'
  const rules = {
    present: {
      er: 'I группа (-ER), présent:\nje -e · tu -es · il -e\nnous -ons · vous -ez · ils -ent',
      ir: 'II группа (-IR), présent:\nje -is · tu -is · il -it\nnous -issons · vous -issez · ils -issent',
      re: 'III группа (-RE), présent:\nje -s · tu -s · il -\nnous -ons · vous -ez · ils -ent',
      irr: 'Неправильный глагол — формы нужно запомнить. Présent часто меняет основу.'
    },
    passe: {
      er: 'Passé composé:\navoir/être (présent) + participe passé\n-ER → -é (parlé)',
      ir: 'Passé composé:\navoir/être + participe passé\n-IR → -i (fini)',
      re: 'Passé composé:\navoir/être + participe passé\n-RE → -u (vendu)',
      irr: 'Passé composé: вспомогательный + причастие.\nПричастие неправильных глаголов запоминается (pris, fait, eu...).'
    },
    imparfait: {
      er: 'Imparfait (от основы nous): -ais -ais -ait -ions -iez -aient',
      ir: 'Imparfait: основа nous (-iss-) + -ais -ais -ait -ions -iez -aient',
      re: 'Imparfait: основа nous + -ais -ais -ait -ions -iez -aient',
      irr: 'Imparfait: берём основу формы nous présent, добавляем -ais, -ais, -ait, -ions, -iez, -aient. Исключение: être → ét-'
    },
    futur: {
      er: 'Futur simple: инфинитив + -ai -as -a -ons -ez -ont',
      ir: 'Futur simple: инфинитив + -ai -as -a -ons -ez -ont',
      re: 'Futur simple: инфинитив без -e + -ai -as -a -ons -ez -ont',
      irr: 'Futur simple: особая основа + -ai -as -a -ons -ez -ont (aller→ir-, avoir→aur-, être→ser-...)'
    }
  };
  const byTense = rules[tense] || rules.present;
  return byTense[g] || byTense.er;
}

window.toggleRule = function() {
  const ruleBox = document.getElementById('rule-box');
  const ruleBtn = document.getElementById('rule-toggle-btn');
  if (!ruleBox) return;
  const isHidden = window.getComputedStyle(ruleBox).display === 'none';
  if (isHidden) {
    const v = getCurrentVerb();
    const t = getCurrentTense() || 'present';
    const ruleText = getConjugationRule(v, t);
    ruleBox.textContent = ruleText;
    ruleBox.style.whiteSpace = 'pre-line';
    ruleBox.style.color = '#e8e0d0';
    ruleBox.style.display = 'block';
    if (ruleBtn) { ruleBtn.style.borderColor = 'var(--accent)'; ruleBtn.style.color = 'var(--accent)'; }
  } else {
    ruleBox.style.display = 'none';
    if (ruleBtn) { ruleBtn.style.borderColor = 'var(--border)'; ruleBtn.style.color = 'var(--text-muted)'; }
  }
};
window.renderHome           = () => renderHome();
window.renderStats          = () => renderStats(VERBS, NOUNS);
window.populateGenVerbList  = populateGenVerbList;
window.setPhrasesMode       = window.setPhrasesMode || (() => {});


// ════════════════════════════════════════════════
// NOUNS — загрузка и тренажёр существительных
// ════════════════════════════════════════════════

const NOUNS_BUILTIN = [
  // corps
  {id:'n1',fr:'bras',ru:'рука (от плеча)',gender:'m',theme:'corps'},
  {id:'n2',fr:'jambe',ru:'нога',gender:'f',theme:'corps'},
  {id:'n3',fr:'tête',ru:'голова',gender:'f',theme:'corps'},
  {id:'n4',fr:'dos',ru:'спина',gender:'m',theme:'corps'},
  {id:'n5',fr:'ventre',ru:'живот',gender:'m',theme:'corps'},
  {id:'n6',fr:'main',ru:'рука (кисть)',gender:'f',theme:'corps'},
  {id:'n7',fr:'pied',ru:'стопа',gender:'m',theme:'corps'},
  {id:'n8',fr:'genou',ru:'колено',gender:'m',theme:'corps'},
  {id:'n9',fr:"l'épaule",ru:'плечо',gender:'f',theme:'corps'},
  {id:'n10',fr:'cœur',ru:'сердце',gender:'m',theme:'corps'},
  // famille
  {id:'n11',fr:'père',ru:'отец',gender:'m',theme:'famille'},
  {id:'n12',fr:'mère',ru:'мать',gender:'f',theme:'famille'},
  {id:'n13',fr:'frère',ru:'брат',gender:'m',theme:'famille'},
  {id:'n14',fr:'sœur',ru:'сестра',gender:'f',theme:'famille'},
  {id:'n15',fr:'fils',ru:'сын',gender:'m',theme:'famille'},
  {id:'n16',fr:'fille',ru:'дочь',gender:'f',theme:'famille'},
  {id:'n17',fr:'mari',ru:'муж',gender:'m',theme:'famille'},
  {id:'n18',fr:'femme',ru:'жена / женщина',gender:'f',theme:'famille'},
  {id:'n19',fr:'grand-père',ru:'дедушка',gender:'m',theme:'famille'},
  {id:'n20',fr:'grand-mère',ru:'бабушка',gender:'f',theme:'famille'},
  // maison
  {id:'n21',fr:'cuisine',ru:'кухня',gender:'f',theme:'maison'},
  {id:'n22',fr:'salon',ru:'гостиная',gender:'m',theme:'maison'},
  {id:'n23',fr:'chambre',ru:'спальня',gender:'f',theme:'maison'},
  {id:'n24',fr:'salle de bain',ru:'ванная',gender:'f',theme:'maison'},
  {id:'n25',fr:'jardin',ru:'сад',gender:'m',theme:'maison'},
  {id:'n26',fr:'fenêtre',ru:'окно',gender:'f',theme:'maison'},
  {id:'n27',fr:'porte',ru:'дверь',gender:'f',theme:'maison'},
  {id:'n28',fr:'sol',ru:'пол',gender:'m',theme:'maison'},
  {id:'n29',fr:'plafond',ru:'потолок',gender:'m',theme:'maison'},
  {id:'n30',fr:'mur',ru:'стена',gender:'m',theme:'maison'},
  // nourriture
  {id:'n31',fr:'pain',ru:'хлеб',gender:'m',theme:'nourriture'},
  {id:'n32',fr:'pomme',ru:'яблоко',gender:'f',theme:'nourriture'},
  {id:'n33',fr:'fromage',ru:'сыр',gender:'m',theme:'nourriture'},
  {id:'n34',fr:'viande',ru:'мясо',gender:'f',theme:'nourriture'},
  {id:'n35',fr:'poisson',ru:'рыба',gender:'m',theme:'nourriture'},
  {id:'n36',fr:'soupe',ru:'суп',gender:'f',theme:'nourriture'},
  {id:'n37',fr:'riz',ru:'рис',gender:'m',theme:'nourriture'},
  {id:'n38',fr:'salade',ru:'салат',gender:'f',theme:'nourriture'},
  {id:'n39',fr:'gâteau',ru:'торт / пирожное',gender:'m',theme:'nourriture'},
  {id:'n40',fr:'fraise',ru:'клубника',gender:'f',theme:'nourriture'},
  // ville
  {id:'n41',fr:'rue',ru:'улица',gender:'f',theme:'ville'},
  {id:'n42',fr:'quartier',ru:'район',gender:'m',theme:'ville'},
  {id:'n43',fr:'mairie',ru:'мэрия',gender:'f',theme:'ville'},
  {id:'n44',fr:'marché',ru:'рынок',gender:'m',theme:'ville'},
  {id:'n45',fr:'pharmacie',ru:'аптека',gender:'f',theme:'ville'},
  {id:'n46',fr:'musée',ru:'музей',gender:'m',theme:'ville'},
  {id:'n47',fr:'bibliothèque',ru:'библиотека',gender:'f',theme:'ville'},
  {id:'n48',fr:'pont',ru:'мост',gender:'m',theme:'ville'},
  {id:'n49',fr:'place',ru:'площадь',gender:'f',theme:'ville'},
  {id:'n50',fr:'cinéma',ru:'кинотеатр',gender:'m',theme:'ville'},
  // transport
  {id:'n51',fr:'train',ru:'поезд',gender:'m',theme:'transport'},
  {id:'n52',fr:'voiture',ru:'машина',gender:'f',theme:'transport'},
  {id:'n53',fr:'bus',ru:'автобус',gender:'m',theme:'transport'},
  {id:'n54',fr:'vélo',ru:'велосипед',gender:'m',theme:'transport'},
  {id:'n55',fr:'moto',ru:'мотоцикл',gender:'f',theme:'transport'},
  {id:'n56',fr:"l'avion",ru:'самолёт',gender:'m',theme:'transport'},
  {id:'n57',fr:'bateau',ru:'лодка / корабль',gender:'m',theme:'transport'},
  {id:'n58',fr:'gare',ru:'вокзал',gender:'f',theme:'transport'},
  {id:'n59',fr:'taxi',ru:'такси',gender:'m',theme:'transport'},
  {id:'n60',fr:'métro',ru:'метро',gender:'m',theme:'transport'},
  // nature
  {id:'n61',fr:'forêt',ru:'лес',gender:'f',theme:'nature'},
  {id:'n62',fr:'mer',ru:'море',gender:'f',theme:'nature'},
  {id:'n63',fr:'montagne',ru:'гора',gender:'f',theme:'nature'},
  {id:'n64',fr:'fleuve',ru:'река (большая)',gender:'m',theme:'nature'},
  {id:'n65',fr:'rivière',ru:'река (малая)',gender:'f',theme:'nature'},
  {id:'n66',fr:'lac',ru:'озеро',gender:'m',theme:'nature'},
  {id:'n67',fr:'plage',ru:'пляж',gender:'f',theme:'nature'},
  {id:'n68',fr:'soleil',ru:'солнце',gender:'m',theme:'nature'},
  {id:'n69',fr:'pluie',ru:'дождь',gender:'f',theme:'nature'},
  {id:'n70',fr:'vent',ru:'ветер',gender:'m',theme:'nature'},
  // travail
  {id:'n71',fr:'bureau',ru:'офис / стол',gender:'m',theme:'travail'},
  {id:'n72',fr:'réunion',ru:'встреча / собрание',gender:'f',theme:'travail'},
  {id:'n73',fr:'patron',ru:'начальник',gender:'m',theme:'travail'},
  {id:'n74',fr:'salaire',ru:'зарплата',gender:'m',theme:'travail'},
  {id:'n75',fr:'collègue',ru:'коллега (ж)',gender:'f',theme:'travail'},
  {id:'n76',fr:'projet',ru:'проект',gender:'m',theme:'travail'},
  {id:'n77',fr:'réunion',ru:'совещание',gender:'f',theme:'travail'},
  {id:'n78',fr:'rapport',ru:'отчёт',gender:'m',theme:'travail'},
  // temps
  {id:'n79',fr:'semaine',ru:'неделя',gender:'f',theme:'temps'},
  {id:'n80',fr:'mois',ru:'месяц',gender:'m',theme:'temps'},
  {id:'n81',fr:"l'année",ru:'год',gender:'f',theme:'temps'},
  {id:'n82',fr:'matin',ru:'утро',gender:'m',theme:'temps'},
  {id:'n83',fr:'soir',ru:'вечер',gender:'m',theme:'temps'},
  {id:'n84',fr:'nuit',ru:'ночь',gender:'f',theme:'temps'},
  {id:'n85',fr:'midi',ru:'полдень',gender:'m',theme:'temps'},
  {id:'n86',fr:'week-end',ru:'выходные',gender:'m',theme:'temps'},
  // vêtements
  {id:'n87',fr:'manteau',ru:'пальто',gender:'m',theme:'vêtements'},
  {id:'n88',fr:'robe',ru:'платье',gender:'f',theme:'vêtements'},
  {id:'n89',fr:'pantalon',ru:'брюки',gender:'m',theme:'vêtements'},
  {id:'n90',fr:'chemise',ru:'рубашка',gender:'f',theme:'vêtements'},
  {id:'n91',fr:'pull',ru:'свитер',gender:'m',theme:'vêtements'},
  {id:'n92',fr:'jupe',ru:'юбка',gender:'f',theme:'vêtements'},
  {id:'n93',fr:'chapeau',ru:'шляпа',gender:'m',theme:'vêtements'},
  {id:'n94',fr:'chaussure',ru:'туфля / ботинок',gender:'f',theme:'vêtements'},
  // animaux
  {id:'n95',fr:'chien',ru:'собака',gender:'m',theme:'animaux'},
  {id:'n96',fr:'chat',ru:'кошка',gender:'m',theme:'animaux'},
  {id:'n97',fr:'cheval',ru:'лошадь',gender:'m',theme:'animaux'},
  {id:'n98',fr:'vache',ru:'корова',gender:'f',theme:'animaux'},
  {id:'n99',fr:'lapin',ru:'кролик',gender:'m',theme:'animaux'},
  {id:'n100',fr:'poule',ru:'курица',gender:'f',theme:'animaux'},
  {id:'n101',fr:'poisson',ru:'рыба',gender:'m',theme:'animaux'},
  {id:'n102',fr:"l'oiseau",ru:'птица',gender:'m',theme:'animaux'},
  // divers
  {id:'n103',fr:'problème',ru:'проблема',gender:'m',theme:'divers'},
  {id:'n104',fr:'solution',ru:'решение',gender:'f',theme:'divers'},
  {id:'n105',fr:'monde',ru:'мир / свет',gender:'m',theme:'divers'},
  {id:'n106',fr:'question',ru:'вопрос',gender:'f',theme:'divers'},
  {id:'n107',fr:'temps',ru:'время / погода',gender:'m',theme:'divers'},
  {id:'n108',fr:'vie',ru:'жизнь',gender:'f',theme:'divers'},
  {id:'n109',fr:'pays',ru:'страна',gender:'m',theme:'divers'},
  {id:'n110',fr:'langue',ru:'язык',gender:'f',theme:'divers'},
];

export async function loadNounsFromCloud() {
  if (NOUNS_LOADED) return;
  NOUNS.length = 0;
  const byId = new Map();
  NOUNS_BUILTIN.forEach(n => byId.set(String(n.id), n));
  try {
    const { data } = await sb.from('nouns').select('*').order('fr', { ascending: true });
    (data || []).forEach(w => {
      const id = w.id || normalizeImportKey(w.fr || w.word || ('noun_' + Date.now()));
      byId.set(String(id), {
        id,
        fr: w.fr || w.word || '',
        ru: w.ru || w.translations || w.meaning || '',
        gender: w.gender || 'm',
        theme: w.theme || 'custom'
      });
    });
  } catch(e) {
    console.warn('[nouns] Firebase nouns load skipped:', e?.message || e);
  }
  byId.forEach(n => NOUNS.push(n));
  setNounsLoaded(true);
}

let currentNoun = null;
let nounWeakMode = false;
let nounGood = 0, nounBad = 0, nounStreak = 0;

window.nounWeakMode = false;

window.toggleNounWeak = function() {
  nounWeakMode = !nounWeakMode;
  window.nounWeakMode = nounWeakMode;
  const btn = document.getElementById('noun-weak-btn');
  if (btn) {
    btn.style.background = nounWeakMode ? 'var(--accent)' : '';
    btn.style.color = nounWeakMode ? '#f5ecd8' : '';
  }
  window.nounNextCard();
};

window.nounNextCard = async function() {
  if (!NOUNS_LOADED) await loadNounsFromCloud();
  const theme = document.getElementById('noun-theme')?.value || 'all';
  const stats = loadStats();

  let pool = NOUNS.filter(n => theme === 'all' || n.theme === theme);
  if (nounWeakMode) {
    pool = pool.filter(n => {
      const s = stats['noun_' + n.id];
      return s && s.total >= 2 && (s.correct / s.total) < 0.6;
    });
    if (!pool.length) {
      document.getElementById('noun-word').textContent = '—';
      document.getElementById('noun-meaning').textContent = 'Нет слабых слов в этой теме!';
      document.getElementById('noun-theme-label').textContent = '';
      document.getElementById('noun-feedback').innerHTML = '';
      document.getElementById('noun-count').textContent = '';
      return;
    }
  }
  if (!pool.length) {
    document.getElementById('noun-word').textContent = '—';
    document.getElementById('noun-meaning').textContent = 'Нет существительных в этой теме';
    return;
  }

  document.getElementById('noun-count').textContent = pool.length + ' слов';
  document.getElementById('noun-answer-area').style.display = 'grid';
  document.getElementById('noun-feedback').innerHTML = '';

  // Weighted random — show weak words more
  const weights = pool.map(n => {
    const s = stats['noun_' + n.id];
    if (!s) return 3;
    const pct = s.correct / s.total;
    return pct < 0.5 ? 5 : pct < 0.75 ? 2 : 1;
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalW;
  let idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

  currentNoun = pool[idx];
  document.getElementById('noun-word').textContent = currentNoun.fr;
  document.getElementById('noun-meaning').textContent = currentNoun.ru;
  const themeLabels = {
    corps:'🫀 Тело', famille:'👨‍👩‍👧 Семья', maison:'🏠 Дом', nourriture:'🍎 Еда',
    ville:'🏙 Город', transport:'🚗 Транспорт', nature:'🌿 Природа',
    travail:'💼 Работа', temps:'⏰ Время', vêtements:'👕 Одежда',
    animaux:'🐾 Животные', divers:'📦 Разное'
  };
  document.getElementById('noun-theme-label').textContent = themeLabels[currentNoun.theme] || currentNoun.theme;

  // Update and reset answer buttons
  const btnM = document.querySelector('[onclick="checkNoun(\'m\')"]');
  const btnF = document.querySelector('[onclick="checkNoun(\'f\')"]');
  if (btnM) { btnM.style.borderColor=''; btnM.style.background=''; btnM.style.color=''; btnM.innerHTML=`<em>le</em> ${currentNoun.fr}`; }
  if (btnF) { btnF.style.borderColor=''; btnF.style.background=''; btnF.style.color=''; btnF.innerHTML=`<em>la</em> ${currentNoun.fr}`; }
};

window.checkNoun = async function(guess) {
  if (!currentNoun) return;
  const isCorrect = guess === currentNoun.gender;
  const stats = loadStats();
  const key = 'noun_' + currentNoun.id;
  if (!stats[key]) stats[key] = { total: 0, correct: 0 };
  stats[key].total++;
  stats[key].lastDate = todayStr(); // daily-task check relies on this
  if (isCorrect) { stats[key].correct++; nounGood++; nounStreak++; }
  else { nounBad++; nounStreak = 0; }
  await saveStats(stats);

  document.getElementById('nscore2-good').textContent = nounGood;
  document.getElementById('nscore2-bad').textContent = nounBad;
  document.getElementById('nscore2-streak').textContent = nounStreak;

  const correctArticle = currentNoun.gender === 'm' ? 'le' : 'la';
  const fullForm = correctArticle + ' ' + currentNoun.fr;
  const fb = document.getElementById('noun-feedback');

  // Highlight buttons
  ['m','f'].forEach(g => {
    const btn = document.querySelector(`[onclick="checkNoun('${g}')"]`);
    if (!btn) return;
    if (g === currentNoun.gender) { btn.style.borderColor = 'var(--good)'; btn.style.background = 'rgba(52,199,89,0.12)'; btn.style.color = 'var(--good)'; }
    else if (g === guess && !isCorrect) { btn.style.borderColor = 'var(--bad)'; btn.style.background = 'rgba(255,59,48,0.1)'; }
  });

  // Gender rule hint
  const fr = currentNoun.fr;
  let hint = '';
  if (!isCorrect) {
    if (fr.endsWith('tion') || fr.endsWith('sion') || fr.endsWith('ée') || fr.endsWith('té')) hint = `Слова на «${fr.slice(-3)}» обычно женского рода`;
    else if (fr.endsWith('ment') || fr.endsWith('age') || fr.endsWith('eur')) hint = `Слова на «${fr.slice(-3)}» обычно мужского рода`;
  }

  fb.innerHTML = isCorrect
    ? `<div style="color:var(--good);font-size:1rem;font-weight:600">✓ ${fullForm}</div>
       <button class="btn btn-primary" onclick="nounNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующее →</button>`
    : `<div><div style="color:var(--bad);font-size:1rem;font-weight:600">✗ Правильно: ${fullForm}</div>
       ${hint ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">${hint}</div>` : ''}
       </div>
       <button class="btn btn-primary" onclick="nounNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующее →</button>`;

  speak(fullForm);
};

// ════════════════════════════════════════════════
// PREPS — тренажёр предлогов
// ════════════════════════════════════════════════

const PREPS_DATA = [
  // verbe + à + inf
  {id:'p1', verb:'commencer', ru:'начинать', prep:'à', example:'Il commence à travailler.', exru:'Он начинает работать.', group:'a_inf'},
  {id:'p2', verb:'apprendre', ru:'учиться', prep:'à', example:'Elle apprend à conduire.', exru:'Она учится водить.', group:'a_inf'},
  {id:'p3', verb:'réussir', ru:'удаваться', prep:'à', example:'Il réussit à finir.', exru:'Ему удаётся закончить.', group:'a_inf'},
  {id:'p4', verb:'aider', ru:'помогать', prep:'à', example:'Tu aides à préparer.', exru:'Ты помогаешь готовить.', group:'a_inf'},
  {id:'p5', verb:'hésiter', ru:'колебаться', prep:'à', example:'Elle hésite à partir.', exru:'Она колеблется уходить.', group:'a_inf'},
  {id:'p6', verb:'inviter', ru:'приглашать', prep:'à', example:'Il invite à entrer.', exru:'Он приглашает войти.', group:'a_inf'},
  // verbe + de + inf
  {id:'p7', verb:'arrêter', ru:'переставать', prep:'de', example:'Il arrête de fumer.', exru:'Он перестаёт курить.', group:'de_inf'},
  {id:'p8', verb:'essayer', ru:'пытаться', prep:'de', example:'Elle essaie de comprendre.', exru:'Она пытается понять.', group:'de_inf'},
  {id:'p9', verb:'décider', ru:'решать', prep:'de', example:'Nous décidons de partir.', exru:'Мы решаем уехать.', group:'de_inf'},
  {id:'p10', verb:'refuser', ru:'отказываться', prep:'de', example:'Il refuse de manger.', exru:'Он отказывается есть.', group:'de_inf'},
  {id:'p11', verb:'oublier', ru:'забывать', prep:'de', example:'Tu oublies de fermer.', exru:'Ты забываешь закрыть.', group:'de_inf'},
  {id:'p12', verb:'finir', ru:'заканчивать', prep:'de', example:'Elle finit de lire.', exru:'Она заканчивает читать.', group:'de_inf'},
  // verbe + à + nom
  {id:'p13', verb:'penser', ru:'думать (о)', prep:'à', example:'Je pense à toi.', exru:'Я думаю о тебе.', group:'a_nom'},
  {id:'p14', verb:'ressembler', ru:'быть похожим (на)', prep:'à', example:'Il ressemble à son père.', exru:'Он похож на отца.', group:'a_nom'},
  {id:'p15', verb:'s\'intéresser', ru:'интересоваться', prep:'à', example:'Elle s\'intéresse à l\'art.', exru:'Она интересуется искусством.', group:'a_nom'},
  {id:'p16', verb:'tenir', ru:'дорожить', prep:'à', example:'Je tiens à ma famille.', exru:'Я дорожу семьёй.', group:'a_nom'},
  // verbe + de + nom
  {id:'p17', verb:'parler', ru:'говорить (о)', prep:'de', example:'Nous parlons de lui.', exru:'Мы говорим о нём.', group:'de_nom'},
  {id:'p18', verb:'avoir besoin', ru:'нуждаться (в)', prep:'de', example:'J\'ai besoin de temps.', exru:'Мне нужно время.', group:'de_nom'},
  {id:'p19', verb:'se souvenir', ru:'помнить (о)', prep:'de', example:'Tu te souviens de lui.', exru:'Ты помнишь его.', group:'de_nom'},
  {id:'p20', verb:'manquer', ru:'не хватать', prep:'de', example:'Il manque de courage.', exru:'Ему не хватает смелости.', group:'de_nom'},
  // other
  {id:'p21', verb:'compter', ru:'рассчитывать (на)', prep:'sur', example:'Je compte sur toi.', exru:'Я рассчитываю на тебя.', group:'other'},
  {id:'p22', verb:'rêver', ru:'мечтать (о)', prep:'de', example:'Elle rêve de voyager.', exru:'Она мечтает путешествовать.', group:'other'},
  {id:'p23', verb:'remercier', ru:'благодарить (за)', prep:'pour', example:'Merci pour tout.', exru:'Спасибо за всё.', group:'other'},
  {id:'p24', verb:'se marier', ru:'жениться (на)', prep:'avec', example:'Il se marie avec elle.', exru:'Он женится на ней.', group:'other'},
];

let currentPrep = null;
let prepGood = 0, prepBad = 0, prepStreak = 0;
window.currentPrep = null;

window.prepNextCard = function() {
  const group = document.getElementById('prep-group')?.value || 'all';
  const stats = loadStats();
  let pool = group === 'all' ? PREPS_DATA : PREPS_DATA.filter(p => p.group === group);
  if (!pool.length) return;

  document.getElementById('prep-count').textContent = pool.length + ' конструкций';
  document.getElementById('prep-feedback').innerHTML = '';

  // Weighted pick
  const weights = pool.map(p => {
    const s = stats['prep_' + p.id];
    if (!s) return 3;
    return (s.correct / s.total) < 0.6 ? 5 : 1;
  });
  const totalW = weights.reduce((a,b)=>a+b,0);
  let r = Math.random() * totalW, idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

  currentPrep = pool[idx];
  window.currentPrep = currentPrep;

  document.getElementById('prep-verb').textContent = currentPrep.verb;
  document.getElementById('prep-ru').textContent = currentPrep.ru;
  document.getElementById('prep-example-blank').innerHTML = currentPrep.example.replace(currentPrep.prep, '<span style="color:var(--accent);font-weight:600">___</span>');
  document.getElementById('prep-exru').textContent = currentPrep.exru;

  // Build answer buttons — correct + 3 distractors
  const allPreps = ['à','de','sur','pour','avec','en','par','dans'];
  const distractors = allPreps.filter(p => p !== currentPrep.prep).sort(() => Math.random()-0.5).slice(0,3);
  const choices = [currentPrep.prep, ...distractors].sort(() => Math.random()-0.5);

  const area = document.getElementById('prep-answer-area');
  area.innerHTML = choices.map(p =>
    `<button onclick="checkPrep('${p}')" style="padding:12px 24px;font-family:'IBM Plex Mono',monospace;font-size:1.1rem;border:2px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);cursor:pointer;min-width:80px;transition:all 0.2s">${p}</button>`
  ).join('');
};

window.checkPrep = async function(guess) {
  if (!currentPrep) return;
  const isCorrect = guess === currentPrep.prep;
  const stats = loadStats();
  const key = 'prep_' + currentPrep.id;
  if (!stats[key]) stats[key] = { total: 0, correct: 0 };
  stats[key].total++;
  stats[key].lastDate = todayStr(); // daily-task check relies on this
  if (isCorrect) { stats[key].correct++; prepGood++; prepStreak++; }
  else { prepBad++; prepStreak = 0; }
  await saveStats(stats);

  document.getElementById('pscore-good').textContent = prepGood;
  document.getElementById('pscore-bad').textContent = prepBad;
  document.getElementById('pscore-streak').textContent = prepStreak;

  // Highlight buttons
  document.querySelectorAll('#prep-answer-area button').forEach(btn => {
    const p = btn.textContent.trim();
    if (p === currentPrep.prep) { btn.style.borderColor = 'var(--good)'; btn.style.background = 'rgba(52,199,89,0.12)'; btn.style.color = 'var(--good)'; }
    else if (p === guess && !isCorrect) { btn.style.borderColor = 'var(--bad)'; btn.style.background = 'rgba(255,59,48,0.1)'; }
    btn.disabled = true;
  });

  document.getElementById('prep-example-blank').innerHTML = currentPrep.example.replace(
    currentPrep.prep, `<strong style="color:var(--good)">${currentPrep.prep}</strong>`
  );

  const fb = document.getElementById('prep-feedback');
  fb.innerHTML = isCorrect
    ? `<div style="color:var(--good);font-weight:600">✓ ${currentPrep.verb} ${currentPrep.prep}</div>
       <button class="btn btn-primary" onclick="prepNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующая →</button>`
    : `<div style="color:var(--bad);font-weight:600">✗ Правильно: ${currentPrep.verb} <strong>${currentPrep.prep}</strong></div>
       <button class="btn btn-primary" onclick="prepNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующая →</button>`;

  if (isCorrect) speak(currentPrep.example);
};

// ════════════════════════════════════════════════
// exitReviewMode + setNumRange
// ════════════════════════════════════════════════
window.exitReviewMode = function() {
  // Leave weak-verbs review and return to the normal trainer
  setReviewMode(false);
  resetTrainer();
};

// "Слабые глаголы" task on the dashboard: trainer in weak-verbs-only mode.
// (Was referenced from the dashboard but never implemented.)
window.startTrainerReview = function() {
  setReviewMode(true);
  showScreen('trainer');
  resetTrainer();
};

window.setNumRange = function(from, to) {
  const fromEl = document.getElementById('num-from');
  const toEl = document.getElementById('num-to');
  if (fromEl) fromEl.value = from;
  if (toEl) toEl.value = to;
  if (window.nextNumber) window.nextNumber();
};

// Signal proxy that module is ready — MUST be last

// ════════════════════════════════════════════════
// PHRASES AI MODES — Перевод и Вопросы (Gemini)
// ════════════════════════════════════════════════

// AI check via Supabase Edge Function (DeepSeek key stored server-side)

let phMode = 'fill'; // 'fill' | 'construct' | 'translate' | 'question'
window.phMode = phMode;
document.documentElement.dataset.phMode = phMode;
let phDifficulty = 'medium'; // 'easy' | 'medium' | 'hard'

const PH_DIFFICULTY = {
  easy:   { levels: ['A1'],             label: '🟢 Débutant' },
  medium: { levels: ['A1','A2'],        label: '🟡 Intermédiaire' },
  hard:   { levels: ['A1','A2','B1','B2'], label: '🔴 Avancé' },
};

window.setPhrasesMode = function(mode) {
  if (!['fill','construct'].includes(mode)) {
    showToast('ИИ-режимы фраз пока скрыты — сначала доводим ручную базу.');
    mode = 'fill';
  }
  phMode = mode;
  window.phMode = phMode;
  document.documentElement.dataset.phMode = phMode;
  try { localStorage.setItem('an2_phrase_mode', phMode); } catch {}

  // Update tab buttons
  ['fill','construct','translate','question'].forEach(m => {
    const btn = document.getElementById(`ph-mode-${m}-btn`);
    if (!btn) return;
    const active = m === mode;
    btn.style.background = active ? 'var(--accent)' : 'none';
    btn.style.color = active ? '#f5ecd8' : 'var(--text-muted)';
    btn.style.fontWeight = active ? '600' : '400';
  });

  // Show/hide filters vs difficulty
  const filtersRow = document.getElementById('ph-filters-row');
  const diffRow = document.getElementById('ph-difficulty-row');
  const fillAnswer = document.getElementById('ph-answer-fill');
  const aiAnswer = document.getElementById('ph-answer-ai');
  const aiFeedback = document.getElementById('ph-ai-feedback');

  if (mode === 'fill' || mode === 'construct') {
    if (filtersRow) filtersRow.style.display = 'flex';
    if (diffRow) diffRow.style.display = 'none';
    if (fillAnswer) fillAnswer.style.display = 'block';
    if (aiAnswer) aiAnswer.style.display = 'none';
    if (aiFeedback) aiFeedback.style.display = 'none';
    const inp = document.getElementById('ph-input');
    if (inp) {
      inp.placeholder = mode === 'construct' ? 'введи предложение полностью...' : 'введи пропущенную форму...';
      inp.rows = mode === 'construct' ? 3 : 1;
      inp.style.minHeight = mode === 'construct' ? '108px' : '54px';
      inp.style.fontSize = mode === 'construct' ? '1.02rem' : '';
      inp.style.textAlign = mode === 'construct' ? 'left' : '';
      inp.style.fontFamily = mode === 'construct' ? "'IBM Plex Sans', sans-serif" : "'IBM Plex Mono', monospace";
      inp.style.resize = mode === 'construct' ? 'vertical' : 'none';
    }
    window.nextPhrase?.();
    window.autoResizePhraseInput?.();
  } else {
    if (filtersRow) filtersRow.style.display = 'none';
    if (diffRow) diffRow.style.display = 'flex';
    if (fillAnswer) fillAnswer.style.display = 'none';
    if (aiAnswer) aiAnswer.style.display = 'block';
    if (aiFeedback) aiFeedback.style.display = 'none';
    const inp = document.getElementById('ph-ai-input');
    if (inp) inp.value = '';
    loadAIPhrase();
  }
};
window.phMode = phMode;

window.autoResizePhraseInput = function() {
  const el = document.getElementById('ph-input');
  if (!el) return;
  if ((window.phMode || 'fill') === 'construct') {
    el.style.height = 'auto';
    el.style.height = Math.max(108, Math.min(el.scrollHeight + 4, 220)) + 'px';
  }
};


window.setPhDifficulty = function(level) {
  phDifficulty = level;

  ['easy','medium','hard'].forEach(l => {
    const btn = document.getElementById(`ph-diff-${l}`);
    if (!btn) return;
    const active = l === level;
    btn.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    btn.style.background = active ? 'rgba(212,175,55,0.12)' : 'none';
    btn.style.color = active ? 'var(--accent)' : 'var(--text-muted)';
  });

  loadAIPhrase();
};

let currentAIPhrase = null;

function getAIPhrasePool() {
  const diff = PH_DIFFICULTY[phDifficulty];
  return PHRASES.filter(p => {
    // If specific verbs are selected, only show their phrases
    if (phSelectedVerbs.size > 0 && !phSelectedVerbs.has(p.verbId)) return false;
    // Filter by level field if available, fallback to tense-based
    if (p.level && p.level !== 'A2') {
      return diff.levels.includes(p.level);
    }
    // Fallback for unrated phrases
    if (phDifficulty === 'easy') {
      const verb = VERBS.find(v => v.id === p.verbId);
      const basicVerbs = ['être','avoir','aller','faire','pouvoir','vouloir','venir','dire','voir','savoir'];
      return p.tense === 'present' && (verb?.group === 'er' || basicVerbs.includes(verb?.inf));
    }
    if (phDifficulty === 'medium') return ['present','passe','imparfait'].includes(p.tense);
    return true;
  });
}

window.loadAIPhrase = function() {
  const pool = getAIPhrasePool();
  const aiFeedback = document.getElementById('ph-ai-feedback');
  const aiInput = document.getElementById('ph-ai-input');
  const card = document.getElementById('ph-card');
  const badge = document.getElementById('ph-badge');
  const sentence = document.getElementById('ph-sentence');
  const ruEl = document.getElementById('ph-ru');

  if (aiFeedback) aiFeedback.style.display = 'none';
  if (aiInput) { aiInput.value = ''; aiInput.disabled = false; }

  const checkBtn = document.getElementById('ph-ai-check-btn');
  if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '✨ Проверить'; }

  if (!pool.length) {
    if (sentence) sentence.textContent = 'Нет фраз для этого уровня';
    return;
  }

  currentAIPhrase = pool[Math.floor(Math.random() * pool.length)];
  const verb = VERBS.find(v => v.id === currentAIPhrase.verbId);

  if (badge) {
    badge.textContent = verb ? `${verb.inf.toUpperCase()} · ${currentAIPhrase.tense.toUpperCase()}` : '—';
  }

  if (phMode === 'translate') {
    // Show Russian, user writes French
    if (sentence) {
      sentence.style.fontStyle = 'normal';
      sentence.style.color = 'var(--text)';
      sentence.textContent = currentAIPhrase.ru || '—';
    }
    if (ruEl) ruEl.textContent = '';
    const inp = document.getElementById('ph-ai-input');
    if (inp) inp.placeholder = 'Переведи это предложение на французский...';
  } else {
    // Show French, user writes a question
    const fullFr = currentAIPhrase.fr.includes('___')
      ? currentAIPhrase.fr.replace('___', currentAIPhrase.answer || '___')
      : currentAIPhrase.fr;
    if (sentence) {
      sentence.style.fontStyle = 'italic';
      sentence.style.color = 'var(--text)';
      sentence.textContent = fullFr;
    }
    if (ruEl) ruEl.textContent = currentAIPhrase.ru || '';
    const inp = document.getElementById('ph-ai-input');
    if (inp) inp.placeholder = 'Задай вопрос к этому предложению по-французски...';
  }
};

window.checkPhraseAI = async function() {
  if (window.guardGuest && window.guardGuest('AI-проверка')) return;
  if (!currentAIPhrase) return;
  const inp = document.getElementById('ph-ai-input');
  const userAnswer = inp?.value.trim();
  if (!userAnswer) { if (inp) inp.focus(); return; }

  const checkBtn = document.getElementById('ph-ai-check-btn');
  if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '⏳ Проверяю...'; }

  const aiFeedback = document.getElementById('ph-ai-feedback');
  const aiResult = document.getElementById('ph-ai-result');

  if (aiFeedback) aiFeedback.style.display = 'none';

  const fullFr = currentAIPhrase.fr.includes('___')
    ? currentAIPhrase.fr.replace('___', currentAIPhrase.answer || '')
    : currentAIPhrase.fr;



  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/check-phrase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
      },
      body: JSON.stringify({
        mode: phMode,
        userAnswer,
        originalRu: currentAIPhrase.ru,
        correctFr: fullFr,
      })
    }, LONG_REQUEST_TIMEOUT_MS);

    if (!res.ok) throw new Error(`Ошибка сервера ${res.status}`);
    const data = await res.json();
    const text = data.feedback || 'Нет ответа';

    if (aiResult) {
      // Detect correct/incorrect roughly
      const isGood = /верно|правильно|отлично|хорошо|принято|корректно/i.test(text) &&
                     !/ошибк|неправильно|неверно|неточно/i.test(text);
      aiResult.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span style="font-size:1.3rem">${isGood ? '✅' : '💬'}</span>
          <div style="line-height:1.7;font-size:0.9rem">${text.replace(/\n/g, '<br>')}</div>
        </div>`;
    }

    if (aiFeedback) aiFeedback.style.display = 'block';
    if (inp) inp.disabled = true;

    // Scroll to feedback
    setTimeout(() => aiFeedback?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  } catch(e) {
    if (aiResult) aiResult.innerHTML = `<span style="color:var(--bad)">⚠ Ошибка: ${e.message}</span>`;
    if (aiFeedback) aiFeedback.style.display = 'block';
    if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '✨ Проверить'; }
  }
};

// Override nextPhrase for AI modes
const _origNextPhrase = window.nextPhrase;
window.nextPhrase = function() {
  if (phMode !== 'fill') {
    window.loadAIPhrase();
  } else {
    _origNextPhrase?.();
  }
};



// ════════════════════════════════════════════════
// STUDY — Tense switcher
// ════════════════════════════════════════════════

let learnCurrentTense = 'present';
window.learnCurrentTense = 'present';

window.setLearnTense = function(tense) {
  learnCurrentTense = tense;
  window.learnCurrentTense = tense;
  ['present','passe','imparfait','futur'].forEach(t => {
    const btn = document.getElementById('learn-tense-' + t);
    if (!btn) return;
    btn.style.background = t === tense ? 'var(--accent)' : 'none';
    btn.style.color = t === tense ? '#f5ecd8' : 'var(--text-muted)';
    btn.style.fontWeight = t === tense ? '600' : '400';
  });
  renderLearnTenseTable();
};

function renderLearnTenseTable() {
  const v = getLearnVerb();
  if (!v) return;
  const table = document.getElementById('learn-conj-table');
  const tenseLabel = document.getElementById('learn-tense-label');
  const auxInfo = document.getElementById('learn-aux-info');
  const exEl = document.getElementById('learn-example');
  const pronouns = ['je','tu','il/elle','nous','vous','ils/elles'];
  // Single source of truth for the current learning tense
  const learnCurrentTense = window.learnCurrentTense || 'present';

  if (learnCurrentTense === 'present') {
    const forms = v.conj?.present || [];
    if (tenseLabel) tenseLabel.textContent = "Présent de l'indicatif";
    if (auxInfo) auxInfo.style.display = 'none';
    if (table) table.innerHTML = pronouns.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem">${forms[i] || '—'}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, forms[i] || ''))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`).join('');
    if (exEl) exEl.textContent = v.ex?.present || '';
  } else if (learnCurrentTense === 'passe') {
    const pp = v.pp || (v.inf.endsWith('er') ? v.inf.slice(0,-2)+'é' : v.inf.endsWith('ir') ? v.inf.slice(0,-1) : v.inf);
    const aux = v.aux === 'être' ? 'être' : 'avoir';
    const etreConj = ['suis','es','est','sommes','êtes','sont'];
    const avoirConj = ['ai','as','a','avons','avez','ont'];
    const auxForms = aux === 'être' ? etreConj : avoirConj;
    const agreements = aux === 'être'
      ? [pp, pp, pp+'/'+pp+'e', pp+'s', pp+'s', pp+'s/'+pp+'es']
      : [pp, pp, pp, pp, pp, pp];
    if (tenseLabel) tenseLabel.textContent = 'Passé composé';
    if (auxInfo) {
      auxInfo.style.display = 'block';
      auxInfo.innerHTML = `Вспомогательный: <strong style="color:var(--accent)">${aux}</strong> + participe passé <strong style="color:var(--accent)">${pp}</strong>${aux === 'être' ? ' · согласование' : ''}`;
    }
    if (table) table.innerHTML = pronouns.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.9rem"><span style="color:var(--blue)">${auxForms[i]}</span> ${agreements[i]}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, auxForms[i] + ' ' + pp))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`).join('');
    if (exEl) exEl.textContent = v.ex?.passe || `Il a ${pp}.`;
  } else if (learnCurrentTense === 'imparfait') {
    const forms = v.conj?.imparfait || [];
    if (tenseLabel) tenseLabel.textContent = 'Imparfait';
    if (auxInfo) auxInfo.style.display = 'none';
    const suffixes = ['ais','ais','ait','ions','iez','aient'];
    const stem = (v.conj?.present?.[3] || '').replace(/ons$/, '');
    if (table) table.innerHTML = pronouns.map((p, i) => {
      const form = forms.length ? (forms[i] || '—') : (stem + suffixes[i]);
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem">${form}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, form))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`;
    }).join('');
    if (exEl) exEl.textContent = v.ex?.imparfait || '';
  } else if (learnCurrentTense === 'futur') {
    let forms = v.conj?.futur || [];
    if (!forms.length) {
      let stem = v.inf; if (stem.endsWith('e')) stem = stem.slice(0, -1);
      const suf = ['ai','as','a','ons','ez','ont'];
      forms = suf.map(s => stem + s);
    }
    if (tenseLabel) tenseLabel.textContent = 'Futur simple';
    if (auxInfo) auxInfo.style.display = 'none';
    if (table) table.innerHTML = pronouns.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem">${forms[i] || '—'}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, forms[i] || ''))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`).join('');
    if (exEl) exEl.textContent = v.ex?.futur || '';
  }
}

const _origLearnVerbStart2 = window.learnVerbStart;
window.learnVerbStart = function(verbId, VERBS) {
  // Default entry = présent. The chip path (learnVerbInTense) overrides afterwards.
  learnCurrentTense = 'present';
  window.learnCurrentTense = 'present';
  _origLearnVerbStart2?.(verbId, VERBS);
};
window.renderLearnTenseTable = renderLearnTenseTable;




// ════════════════════════════════════════════════
// MANUAL WORDS / PREPOSITIONS + XLSX IMPORT (v28)
// ════════════════════════════════════════════════

function escapeHtmlLocal(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function pickField(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return String(row[name]).trim();
  }
  const keys = Object.keys(row || {});
  for (const key of keys) {
    const norm = key.trim().toLowerCase();
    if (names.map(n => n.toLowerCase()).includes(norm)) return String(row[key] ?? '').trim();
  }
  return '';
}

function parseExamplesFromContext(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s+[—–-]\s+|\s+\|\s+|\s*::\s*/);
    return { fr: (parts[0] || line).trim(), ru: (parts.slice(1).join(' — ') || '').trim() };
  });
}

function parseFormsFlexible(raw) {
  const parts = String(raw || '').split(/[\n;,]+/).map(x => x.trim()).filter(Boolean);
  return parts.length === 6 ? parts : [];
}

function inferVerbGroup(inf, explicit = '') {
  const g = String(explicit || '').trim().toLowerCase();
  if (['er','ir','re','irr','ref'].includes(g)) return g;
  const v = String(inf || '').toLowerCase();
  if (v.startsWith('se ') || v.startsWith("s'")) return 'ref';
  if (v.endsWith('er')) return 'er';
  if (v.endsWith('ir')) return 'ir';
  if (v.endsWith('re')) return 're';
  return 'irr';
}

function parsePrepConstruction(raw) {
  const text = String(raw || '').trim();
  const parts = text.split(/\s+/);
  const known = ['à','de','sur','pour','avec','en','dans','par','contre','chez','vers','sans'];
  const prep = parts.find(p => known.includes(p.toLowerCase())) || '';
  const idx = prep ? parts.indexOf(prep) : -1;
  const verb = idx > 0 ? parts.slice(0, idx).join(' ') : (parts[0] || text);
  return { verb, prep, full: text };
}

async function maybeCreatePhraseFromContext({ context, verbId, tense = 'present', translation = '', level = 'A1' }) {
  const examples = parseExamplesFromContext(context);
  const ex = examples.find(e => e.fr.includes('___'));
  if (!ex || !verbId) return null;
  const id = normalizeImportKey(`${verbId}_${tense}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`);
  const phrase = {
    id,
    verb_id: verbId,
    tense,
    fr: ex.fr,
    answer: '',
    ru: ex.ru || translation || '',
    level,
    custom: true,
    source: 'xlsx_context',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Без ответа такая фраза для тренировки бесполезна. Сохраняем только если ответ задан после ___ как [answer=...]
  const m = String(context || '').match(/answer\s*=\s*([^;\n]+)/i);
  if (!m) return null;
  phrase.answer = m[1].trim();
  const { error } = await sb.from('phrases').upsert(phrase);
  if (!error) {
    PHRASES.push({ id: phrase.id, verbId: phrase.verb_id, tense: phrase.tense, fr: phrase.fr, answer: phrase.answer, ru: phrase.ru, level: phrase.level, custom: true });
  }
  return error ? null : phrase;
}

function ensureManualWordModal() {
  let modal = document.getElementById('manual-word-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'manual-word-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.72);align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:100%;max-width:620px;max-height:90vh;overflow-y:auto;">
      <div id="manual-word-title" style="font-size:1rem;font-weight:600;color:var(--text);margin-bottom:4px">➕ Добавить запись вручную</div>
      <div style="font-size:.78rem;color:var(--text-muted);margin-bottom:16px">Пишем сразу в Firebase. DeepSeek не трогаем — пусть пока курит в коридоре.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Тип</label><select id="manual-word-type" class="select-control" style="width:100%"><option value="nouns">Слово</option><option value="preps">Предлог / конструкция</option></select></div>
        <div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Уровень</label><select id="manual-word-level" class="select-control" style="width:100%"><option>A1</option><option selected>A2</option><option>B1</option><option>B2</option></select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Слово / конструкция</label><input id="manual-word-fr" placeholder="chien / penser à" style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>
        <div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Переводы</label><input id="manual-word-ru" placeholder="собака / думать о" style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Транскрипция / пометка</label><input id="manual-word-transcription" placeholder="необязательно" style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>
        <div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Род / тема</label><input id="manual-word-meta" placeholder="m / f / ville / travail" style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);"></div>
      </div>
      <div style="margin-bottom:12px"><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Контекст</label><textarea id="manual-word-context" rows="3" placeholder="Je pense à toi. — Я думаю о тебе." style="width:100%;box-sizing:border-box;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);resize:vertical"></textarea></div>
      <div id="manual-word-status" style="display:none;font-size:.82rem;margin-bottom:12px;text-align:center;padding:8px;border-radius:8px;background:var(--surface2)"></div>
      <div style="display:flex;gap:8px"><button onclick="closeManualWordModal()" class="btn btn-secondary" style="flex:1">Отмена</button><button onclick="saveManualWord()" id="manual-word-confirm" class="btn btn-primary" style="flex:1">Сохранить</button></div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

window.showManualWordModal = function(type = null) {
  if (window.guardGuest && window.guardGuest('Добавление записи')) return;
  if (!window.isAdmin || !window.isAdmin()) { showToast('🔒 Добавление доступно только администратору'); return; }
  const modal = ensureManualWordModal();
  modal.dataset.editType = '';
  modal.dataset.editId = '';
  modal.dataset.oldTable = '';

  const title = modal.querySelector('#manual-word-title');
  const confirm = modal.querySelector('#manual-word-confirm');
  if (title) title.textContent = '➕ Добавить запись вручную';
  if (confirm) confirm.textContent = 'Сохранить';

  const typeEl = modal.querySelector('#manual-word-type');
  if (typeEl) {
    typeEl.value = type || (dictType === 'preps' ? 'preps' : 'nouns');
    typeEl.disabled = false;
  }
  const level = modal.querySelector('#manual-word-level'); if (level) level.value = 'A2';
  ['manual-word-fr','manual-word-ru','manual-word-transcription','manual-word-meta','manual-word-context'].forEach(id => { const el = modal.querySelector('#'+id); if (el) el.value = ''; });
  const st = modal.querySelector('#manual-word-status'); if (st) { st.style.display = 'none'; st.textContent = ''; }
  modal.style.display = 'flex';
};

window.editDictWord = function(type, id) {
  if (window.guardGuest && window.guardGuest('Редактирование записи')) return;
  if (!window.isAdmin || !window.isAdmin()) { showToast('🔒 Редактирование доступно только администратору'); return; }

  const modal = ensureManualWordModal();
  const source = type === 'prep' || type === 'preps' ? dictPrepsCache : dictNounsCache;
  const item = source.find(x => String(x.id) === String(id));
  if (!item) { showToast('⚠️ Запись не найдена'); return; }

  const uiType = (type === 'prep' || type === 'preps') ? 'preps' : 'nouns';
  modal.dataset.editType = uiType;
  modal.dataset.editId = String(item.id);
  modal.dataset.oldTable = uiType === 'preps' ? 'prepositions' : 'nouns';

  const title = modal.querySelector('#manual-word-title');
  const confirm = modal.querySelector('#manual-word-confirm');
  if (title) title.textContent = uiType === 'preps' ? '✏️ Редактировать конструкцию' : '✏️ Редактировать слово';
  if (confirm) confirm.textContent = 'Сохранить изменения';

  const typeEl = modal.querySelector('#manual-word-type');
  if (typeEl) { typeEl.value = uiType; typeEl.disabled = true; }
  const levelEl = modal.querySelector('#manual-word-level'); if (levelEl) levelEl.value = item.level || 'A2';
  const frEl = modal.querySelector('#manual-word-fr'); if (frEl) frEl.value = item.fr || item.verb || '';
  const ruEl = modal.querySelector('#manual-word-ru'); if (ruEl) ruEl.value = item.ru || item.translations || item.meaning || '';
  const trEl = modal.querySelector('#manual-word-transcription'); if (trEl) trEl.value = item.transcription || '';
  const metaEl = modal.querySelector('#manual-word-meta');
  if (metaEl) metaEl.value = uiType === 'preps' ? (item.theme || 'custom') : (item.gender || item.theme || 'custom');

  const contextEl = modal.querySelector('#manual-word-context');
  if (contextEl) {
    if (item.context) contextEl.value = item.context;
    else if (Array.isArray(item.examples) && item.examples.length) {
      contextEl.value = item.examples.map(e => `${e.fr || ''}${e.ru ? ' — ' + e.ru : ''}`).join('\n');
    } else contextEl.value = '';
  }

  const st = modal.querySelector('#manual-word-status'); if (st) { st.style.display = 'none'; st.textContent = ''; }
  modal.style.display = 'flex';
};


window.closeManualWordModal = function() {
  const modal = document.getElementById('manual-word-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.dataset.editType = '';
    modal.dataset.editId = '';
    modal.dataset.oldTable = '';
    const typeEl = modal.querySelector('#manual-word-type');
    if (typeEl) typeEl.disabled = false;
  }
};

window.saveManualWord = async function() {
  const modal = ensureManualWordModal();
  const editId = modal.dataset.editId || '';
  const editType = modal.dataset.editType || '';
  const oldTable = modal.dataset.oldTable || '';
  const type = editType || modal.querySelector('#manual-word-type')?.value || 'nouns';

  const fr = modal.querySelector('#manual-word-fr')?.value.trim() || '';
  const ru = modal.querySelector('#manual-word-ru')?.value.trim() || '';
  const transcription = modal.querySelector('#manual-word-transcription')?.value.trim() || '';
  const meta = modal.querySelector('#manual-word-meta')?.value.trim() || '';
  const context = modal.querySelector('#manual-word-context')?.value.trim() || '';
  const level = modal.querySelector('#manual-word-level')?.value || 'A2';
  const st = modal.querySelector('#manual-word-status');
  const btn = modal.querySelector('#manual-word-confirm');

  try {
    if (!fr) throw new Error('Введи слово или конструкцию.');
    if (!ru) throw new Error('Введи перевод.');
    if (st) { st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = editId ? '⏳ Обновляю...' : '⏳ Сохраняю...'; }
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Сохраняю...'; }

    const examples = parseExamplesFromContext(context);

    if (type === 'nouns') {
      const id = normalizeImportKey(fr);
      const gender = ['m','f'].includes(meta.toLowerCase()) ? meta.toLowerCase() : 'm';
      const theme = ['m','f'].includes(meta.toLowerCase()) ? 'custom' : (meta || 'custom');
      const old = editId ? dictNounsCache.find(x => String(x.id) === String(editId)) : null;
      const record = {
        ...(old || {}),
        id, fr, ru, translations: ru, transcription, context, examples,
        gender, theme, level, source: old?.source || 'manual', custom:true,
        created_at: old?.created_at || new Date().toISOString(),
        updated_at:new Date().toISOString()
      };
      const { error } = await sb.from('nouns').upsert(record);
      if (error) throw error;
      if (editId && editId !== id) {
        const del = await sb.from('nouns').delete().eq('id', editId);
        if (del.error) console.warn('[word edit] old key cleanup failed:', del.error.message);
      }

      const oldIdx = dictNounsCache.findIndex(x => String(x.id) === String(editId || id));
      const newIdx = dictNounsCache.findIndex(x => String(x.id) === String(id));
      if (oldIdx >= 0) dictNounsCache.splice(oldIdx, 1);
      if (newIdx >= 0 && newIdx !== oldIdx) dictNounsCache.splice(newIdx, 1);
      dictNounsCache.unshift(record);

      const niOld = NOUNS.findIndex(x => String(x.id) === String(editId || id));
      const n = { id, fr, ru, gender, theme };
      if (niOld >= 0) NOUNS[niOld] = n;
      else NOUNS.push(n);

      setDictTypeValue('nouns');
    } else {
      const parsed = parsePrepConstruction(fr);
      const id = normalizeImportKey(fr);
      const old = editId ? dictPrepsCache.find(x => String(x.id) === String(editId)) : null;
      const prepObj = {
        prep: parsed.prep || old?.preps?.[0]?.prep || '',
        meaning: ru,
        example_fr: examples[0]?.fr || old?.preps?.[0]?.example_fr || '',
        example_ru: examples[0]?.ru || old?.preps?.[0]?.example_ru || ''
      };
      const record = {
        ...(old || {}),
        id, fr, verb: parsed.verb || fr, ru, transcription, context, level,
        preps:[prepObj], examples,
        source: old?.source || 'manual', custom:true,
        created_at: old?.created_at || new Date().toISOString(),
        updated_at:new Date().toISOString()
      };
      const { error } = await sb.from('prepositions').upsert(record);
      if (error) throw error;
      if (editId && editId !== id) {
        const del = await sb.from('prepositions').delete().eq('id', editId);
        if (del.error) console.warn('[prep edit] old key cleanup failed:', del.error.message);
      }

      const oldIdx = dictPrepsCache.findIndex(x => String(x.id) === String(editId || id));
      const newIdx = dictPrepsCache.findIndex(x => String(x.id) === String(id));
      if (oldIdx >= 0) dictPrepsCache.splice(oldIdx, 1);
      if (newIdx >= 0 && newIdx !== oldIdx) dictPrepsCache.splice(newIdx, 1);
      dictPrepsCache.unshift(record);

      const dataIdx = PREPS_DATA.findIndex(x => String(x.id) === String(editId || id));
      const pdata = { id, verb: record.verb, ru, prep: prepObj.prep || '', example: examples[0]?.fr || fr, exru: examples[0]?.ru || ru, group: 'custom' };
      if (dataIdx >= 0) PREPS_DATA[dataIdx] = pdata;
      else PREPS_DATA.push(pdata);

      setDictTypeValue('preps');
    }

    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('an2_cache_nouns') || k.startsWith('an2_cache_prepositions')) localStorage.removeItem(k);
      });
    } catch {}

    if (st) { st.style.color = 'var(--good)'; st.textContent = editId ? '✅ Обновлено' : '✅ Сохранено'; }
    showToast(editId ? '✅ Запись обновлена' : '✅ Запись добавлена');
    setTimeout(() => { window.closeManualWordModal(); window.setDictType(dictType); }, 500);
  } catch(e) {
    if (st) { st.style.display = 'block'; st.style.color = 'var(--bad)'; st.textContent = '❌ ' + (e?.message || e); }
    else showToast('⚠️ ' + (e?.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = editId ? 'Сохранить изменения' : 'Сохранить'; }
  }
};





// ════════════════════════════════════════════════
// KEYBOARD-AWARE SCROLLING
// Ensures action buttons (Далее/Проверить) are reachable
// above the on-screen keyboard. When feedback appears in any
// known feedback container, scroll its "next" button into view.
// ════════════════════════════════════════════════
(function setupKbAwareScroll() {
  const feedbackIds = [
    'check-feedback', 'noun-feedback', 'plural-feedback',
    'feedback-row', 'g-feedback', 'phrase-feedback',
    'ph-ai-feedback', 'prep-feedback', 'num-feedback',
    'match-feedback'
  ];

  function scrollNextIntoView(container) {
    // Prefer a button inside the container; fall back to the container itself
    const btn = container.querySelector('button.btn-primary, button');
    const target = btn || container;
    setTimeout(() => {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    }, 80);
  }

  function attach() {
    feedbackIds.forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.kbObserved) return;
      el.dataset.kbObserved = '1';
      const obs = new MutationObserver(() => {
        if (el.textContent.trim() || el.querySelector('button')) {
          scrollNextIntoView(el);
        }
      });
      obs.observe(el, { childList: true, subtree: true });
    });
  }

  // Attach now and also after a short delay (elements may not exist yet)
  attach();
  setTimeout(attach, 500);
  setTimeout(attach, 1500);

  // Re-attach when switching screens
  const origShowScreen = window.showScreen;
  // (showScreen wrapper handled elsewhere; just re-run attach on click)
  document.addEventListener('click', () => setTimeout(attach, 300), true);
})();

// ════════════════════════════════════════════════
// HANDLER FINALIZER — runs after all window.* assigned
// Position-independent: copies every named handler into
// window.__real_NAME and flips readiness. Even if new code
// is appended below, the worst case is this runs slightly
// early and gets re-run is harmless. To be safe we also
// re-run on next tick.
// ════════════════════════════════════════════════
function __finalizeHandlers() {
  if (Array.isArray(window.__handlers)) {
    window.__handlers.forEach(function(name) {
      // The real implementation is whatever is on window[name] right now,
      // UNLESS it's still the buffering stub (which we detect via a marker).
      var fn = window[name];
      if (typeof fn === 'function' && !fn.__isStub) {
        window['__real_' + name] = fn;
      }
    });
  }
  if (typeof window._moduleResolve === 'function') window._moduleResolve();
}
__finalizeHandlers();
// Defensive: re-run on next tick in case anything assigned late
setTimeout(__finalizeHandlers, 0);


// ════════════════════════════════════════════════
// tts.js — Firebase Cloud Function → OpenRouter/Kokoro
// Browser TTS exists only as an explicit emergency switch.
// ════════════════════════════════════════════════

import { fetchWithTimeout } from './supabase.js';

const TTS_MEM_CACHE = new Map();
const TTS_CACHE_NAME = 'an2-tts-audio-v3';
const TTS_CACHE_LIMIT = 60;

let ttsAudio = null;
let ttsToken = 0;
let ttsCtx = null;
let ttsCurrentSource = null;
let ttsAudioPrimed = false;
let ttsUnlockInstalled = false;

function normalizeLang(lang = 'fr') {
  const raw = String(lang || 'fr').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh') || raw === 'cn' || raw === 'chinese') return 'zh';
  if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en';
  return 'fr';
}

function cloudTtsUrl() {
  const projectId = String(globalThis.FIREBASE_CONFIG?.projectId || 'french-da79a').trim();
  const region = String(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1').trim();
  return `https://${region}-${projectId}.cloudfunctions.net/ttsAudio`;
}

function getAudioContext() {
  if (!ttsCtx) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error('Этот браузер не поддерживает Web Audio.');
    ttsCtx = new AudioCtor();
  }
  return ttsCtx;
}

function primeMobileAudio() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!ttsAudioPrimed) {
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, 22050);
      source.connect(ctx.destination);
      source.start(0);
      ttsAudioPrimed = true;
    }
  } catch (_) {}
}

function installMobileAudioUnlock() {
  if (ttsUnlockInstalled) return;
  ttsUnlockInstalled = true;
  const unlock = () => primeMobileAudio();
  document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  document.addEventListener('touchstart', unlock, { capture: true, passive: true });
  document.addEventListener('keydown', unlock, { capture: true });
}

function normalizeFrenchSpeechText(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  t = t
    .replace(/\bils\s*\/\s*elles\b/gi, 'ils')
    .replace(/\bil\s*\/\s*elle\b/gi, 'il')
    .replace(/\belles\s*\/\s*ils\b/gi, 'ils')
    .replace(/\belle\s*\/\s*il\b/gi, 'il');
  t = t.replace(/\bje\s+([aeiouhàâäéèêëîïôöùûü])/gi, "j'$1");
  t = t.replace(/([^\s\/]+)\/([^\s]+)/g, '$1');
  t = t.replace(/\s+/g, ' ').trim();
  if (t && !/[.!?…]$/.test(t)) t += '.';
  return t;
}

function normalizeSpeechText(text, lang = 'fr') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return normalizeLang(lang) === 'fr' ? normalizeFrenchSpeechText(clean) : clean;
}

function cacheHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cacheRequest(key) {
  return new Request(`${location.origin}/__an2_tts_audio__/${key}.mp3`);
}

async function readPersistentAudio(key) {
  try {
    if (!('caches' in window)) return null;
    const cache = await caches.open(TTS_CACHE_NAME);
    const res = await cache.match(cacheRequest(key));
    if (!res) return null;
    return { buffer: await res.arrayBuffer(), mimeType: res.headers.get('content-type') || 'audio/mpeg' };
  } catch (_) { return null; }
}

async function writePersistentAudio(key, buffer, mimeType = 'audio/mpeg') {
  try {
    if (!('caches' in window)) return;
    const cache = await caches.open(TTS_CACHE_NAME);
    await cache.put(cacheRequest(key), new Response(buffer.slice(0), {
      headers: { 'content-type': mimeType, 'x-an2-created-at': String(Date.now()) }
    }));
    const keys = await cache.keys();
    const stale = Math.max(0, keys.length - TTS_CACHE_LIMIT);
    if (stale) await Promise.all(keys.slice(0, stale).map((entry) => cache.delete(entry)));
  } catch (_) {}
}

async function firebaseCurrentUser(timeoutMs = 7000) {
  const auth = globalThis.firebase?.auth?.();
  if (!auth) throw new Error('Firebase Auth ещё не инициализирован. Перезагрузи приложение и войди снова.');
  if (auth.currentUser) return auth.currentUser;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { unsubscribe?.(); } catch (_) {}
      reject(new Error('Не удалось дождаться Firebase-сессии. Войди в приложение ещё раз.'));
    }, timeoutMs);
    let unsubscribe = null;
    unsubscribe = auth.onAuthStateChanged((user) => {
      if (!user) return;
      clearTimeout(timer);
      try { unsubscribe?.(); } catch (_) {}
      resolve(user);
    });
  });
}

async function firebaseIdToken() {
  const user = await firebaseCurrentUser();
  if (typeof user.getIdToken !== 'function') throw new Error('Firebase-сессия не умеет выдавать токен.');
  return user.getIdToken(false);
}

async function requestFirebaseAudio(text, { lang = 'fr', rate = 1 } = {}) {
  const token = await firebaseIdToken();
  const normalizedLang = normalizeLang(lang);
  const response = await fetchWithTimeout(cloudTtsUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      text,
      lang: normalizedLang,
      speed: Number(rate) || 1,
    }),
  }, 60000);

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Firebase TTS HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength < 200) throw new Error('Firebase TTS вернул пустое аудио.');
  return {
    buffer,
    mimeType: response.headers.get('content-type') || 'audio/mpeg',
    voice: response.headers.get('x-tts-voice') || '',
    lang: response.headers.get('x-tts-lang') || normalizedLang,
  };
}

async function playAudioBuffer(buffer, mimeType = 'audio/mpeg', token = ++ttsToken) {
  if (ttsCurrentSource) { try { ttsCurrentSource.stop(); } catch (_) {} ttsCurrentSource = null; }
  if (ttsAudio) { try { ttsAudio.pause(); } catch (_) {} ttsAudio = null; }
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  try {
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    if (token !== ttsToken) return false;
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    ttsCurrentSource = source;
    // Resolve when audio ends; false means stopped early (ttsToken changed by stopSpeak)
    return new Promise((resolve) => {
      source.onended = () => {
        if (ttsCurrentSource === source) ttsCurrentSource = null;
        resolve(token === ttsToken);
      };
      source.start(0);
    });
  } catch (_) {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    ttsAudio = audio;
    return new Promise((resolve) => {
      audio.onended = () => { URL.revokeObjectURL(url); if (ttsAudio === audio) ttsAudio = null; resolve(true); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
      audio.play().catch(() => resolve(false));
    });
  }
}

function pickBrowserVoice(lang = 'fr') {
  const n = normalizeLang(lang);
  const prefix = n === 'zh' ? 'zh' : n === 'en' ? 'en' : 'fr';
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix) && v.localService)
    || voices.find((v) => v.lang.toLowerCase().startsWith(prefix))
    || null;
}

function speakViaWebSpeech(text, { lang = 'fr', rate = 1 } = {}) {
  if (!window.speechSynthesis) throw new Error('В браузере нет локальной озвучки.');
  const normalizedLang = normalizeLang(lang);
  const prepared = normalizeSpeechText(text, normalizedLang);
  if (!prepared) return Promise.resolve(false);
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(prepared);
  utt.lang = normalizedLang === 'zh' ? 'zh-CN' : normalizedLang === 'en' ? 'en-US' : 'fr-FR';
  utt.rate = Math.max(0.65, Math.min(1.25, Number(rate) || 1));
  const voice = pickBrowserVoice(normalizedLang);
  if (voice) utt.voice = voice;
  return new Promise((resolve) => {
    utt.onend = () => resolve(true);
    utt.onerror = () => resolve(false);
    window.speechSynthesis.speak(utt);
  });
}

export function stopSpeak() {
  ttsToken += 1;
  if (ttsCurrentSource) { try { ttsCurrentSource.stop(); } catch (_) {} ttsCurrentSource = null; }
  if (ttsAudio) { try { ttsAudio.pause(); } catch (_) {} ttsAudio = null; }
  try { window.speechSynthesis?.cancel?.(); } catch (_) {}
}

export async function speak(text, opts = {}) {
  primeMobileAudio();
  const lang = normalizeLang(opts.lang || 'fr');
  const prepared = normalizeSpeechText(text, lang);
  if (!prepared) return false;

  const engine = String(localStorage.getItem('ttsEngine') || 'firebase').toLowerCase() === 'webspeech' ? 'webspeech' : 'firebase';
  if (engine === 'webspeech') return speakViaWebSpeech(prepared, { lang, rate: opts.rate });

  const rate = Math.max(0.7, Math.min(1.2, Number(opts.rate) || (lang === 'zh' ? 0.92 : 0.9)));
  const key = cacheHash(`${lang}|${rate}|${prepared}`);
  stopSpeak();
  const token = ++ttsToken;
  try {
    let cached = TTS_MEM_CACHE.get(key) || null;
    if (!cached) cached = await readPersistentAudio(key);
    if (!cached) {
      cached = await requestFirebaseAudio(prepared, { lang, rate });
      TTS_MEM_CACHE.set(key, cached);
      writePersistentAudio(key, cached.buffer, cached.mimeType);
    } else {
      TTS_MEM_CACHE.set(key, cached);
    }
    if (token !== ttsToken) return false;
    return await playAudioBuffer(cached.buffer, cached.mimeType, token);
  } catch (error) {
    console.warn('[tts] Firebase/OpenRouter TTS failed:', error);
    const msg = String(error?.message || error || 'неизвестная ошибка');
    if (window.showToast) window.showToast(`⚠️ Firebase-озвучка: ${msg.slice(0, 220)}`, 6500);
    return false;
  }
}

export function initSpeech() {
  installMobileAudioUnlock();
  try { window.speechSynthesis?.getVoices?.(); } catch (_) {}
}

export function setTTSEngine(engine) {
  const normalized = String(engine || 'firebase').toLowerCase() === 'webspeech' ? 'webspeech' : 'firebase';
  localStorage.setItem('ttsEngine', normalized);
  document.querySelectorAll('.tts-engine-btn').forEach((b) => b.classList.toggle('active', b.dataset.engine === normalized));
  if (window.showToast) window.showToast(normalized === 'firebase' ? '☁️ Firebase / OpenRouter озвучка включена' : '🧩 Включена аварийная озвучка браузера');
}

export function initTTSEngineUI() {
  const engine = String(localStorage.getItem('ttsEngine') || 'firebase').toLowerCase() === 'webspeech' ? 'webspeech' : 'firebase';
  localStorage.setItem('ttsEngine', engine);
  document.querySelectorAll('.tts-engine-btn').forEach((b) => b.classList.toggle('active', b.dataset.engine === engine));
  const btn = document.getElementById('auto-speak-btn');
  if (btn) {
    btn.textContent = autoSpeak ? 'Вкл' : 'Выкл';
    btn.style.background = autoSpeak ? 'var(--accent)' : 'var(--surface2)';
    btn.style.color = autoSpeak ? '#f5ecd8' : 'var(--text-muted)';
  }
}

export let frKbEnabled = localStorage.getItem('frKbEnabled') !== '0';
export function isFrKbEnabled() { return frKbEnabled; }
export let autoSpeak = localStorage.getItem('autoSpeak') === '1';
let frKbShift = false;
let frKbBlurTimer = null;
let frKbActiveId = null;

export const KB_INPUT_MAP = {
  main:'answer-input', grp:'ganswer-input', ph:'ph-input',
  num:'num-input', learn:'check-input', 'phrase-learn':'phrase-input'
};

export function toggleAutoSpeak() {
  autoSpeak = !autoSpeak;
  localStorage.setItem('autoSpeak', autoSpeak ? '1' : '0');
  const btn = document.getElementById('auto-speak-btn');
  if (btn) {
    btn.textContent = autoSpeak ? 'Вкл' : 'Выкл';
    btn.style.background = autoSpeak ? 'var(--accent)' : 'var(--surface2)';
    btn.style.color = autoSpeak ? '#f5ecd8' : 'var(--text-muted)';
  }
}

// ── French Keyboard ──
export function applyKbMode() {
  const inputs = ['answer-input','ganswer-input','ph-input','num-input','check-input','phrase-input'];
  inputs.forEach(id => {
    const inp = document.getElementById(id);
    if (inp) inp.inputMode = frKbEnabled ? 'none' : 'text';
  });
  ['main','grp','ph','num'].forEach(kbId => {
    const btn = document.getElementById('kb-toggle-' + kbId);
    if (!btn) return;
    btn.textContent = frKbEnabled ? '⌨ Своя клавиатура' : '🇫🇷 Фр. клавиатура';
    btn.classList.toggle('active', !frKbEnabled);
  });
}

export function toggleKbMode(kbId) {
  frKbEnabled = !frKbEnabled;
  localStorage.setItem('frKbEnabled', frKbEnabled ? '1' : '0');
  applyKbMode();
  if (frKbEnabled) {
    showFrKb(kbId);
  } else {
    ['main','grp','ph','num','learn'].forEach(id => hideFrKb(id));
    const inp = document.getElementById(KB_INPUT_MAP[kbId]);
    if (inp) { inp.inputMode = 'text'; inp.focus(); }
  }
}

export function insertFrChar(kbId, ch) {
  const inp = document.getElementById(KB_INPUT_MAP[kbId]); if (!inp) return;
  const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0,s) + ch + inp.value.slice(e);
  inp.selectionStart = inp.selectionEnd = s + ch.length;
  inp.focus({preventScroll:true});
}

export function frBackspace(kbId) {
  const inp = document.getElementById(KB_INPUT_MAP[kbId]); if (!inp) return;
  const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? inp.value.length;
  if (s !== e) { inp.value = inp.value.slice(0,s) + inp.value.slice(e); inp.selectionStart = inp.selectionEnd = s; }
  else if (s > 0) { inp.value = inp.value.slice(0,s-1) + inp.value.slice(s); inp.selectionStart = inp.selectionEnd = s-1; }
  inp.focus({preventScroll:true});
}

export function frEnter(kbId) {
  if (kbId === 'main') window.checkAnswer?.();
  else if (kbId === 'grp') window.gCheckAnswer?.();
  else if (kbId === 'ph') window.checkPhrase?.();
  else if (kbId === 'num') window.checkNumber?.();
}

export function frToggleShift(kbId) {
  frKbShift = !frKbShift;
  const kb = document.getElementById('fr-kb-' + kbId); if (!kb) return;
  const sb = document.getElementById('fr-shift-' + kbId);
  if (sb) { sb.style.background = frKbShift?'var(--accent)':''; sb.style.color = frKbShift?'#0e0e10':''; sb.textContent = frKbShift?'⬆':'⇧'; }
  kb.querySelectorAll('.fr-key:not(.fr-key-action)').forEach(btn => {
    const ch = btn.dataset.ch; if (!ch || ch.length !== 1) return;
    btn.dataset.ch = frKbShift ? ch.toUpperCase() : ch.toLowerCase();
    btn.textContent = btn.dataset.ch;
  });
}

export function showFrKb(kbId) {
  if (!frKbEnabled) return;
  if (frKbBlurTimer) { clearTimeout(frKbBlurTimer); frKbBlurTimer = null; }
  Object.keys(KB_INPUT_MAP).forEach(id => {
    if (id !== kbId) {
      const kb = document.getElementById('fr-kb-' + id);
      if (kb) { kb.style.display = 'none'; kb.classList.remove('kb-visible'); }
    }
  });
  frKbActiveId = kbId;
  buildFrKb(kbId);
  const kb = document.getElementById('fr-kb-' + kbId);
  if (kb) {
    kb.classList.add('kb-visible');
    kb.style.setProperty('display', 'block', 'important');
  }
  const inp = document.getElementById(KB_INPUT_MAP[kbId]);
  if (inp) { inp.setAttribute('inputmode','none'); inp.setAttribute('readonly','readonly'); }
  const indicatorMap = {'learn':'learn-kb-indicator','phrase-learn':'phrase-kb-indicator'};
  if (indicatorMap[kbId]) {
    const ind = document.getElementById(indicatorMap[kbId]);
    if (ind) ind.style.display = 'block';
  }
  const screenId = {main:'trainer',grp:'groups',ph:'phrases',num:'numbers',learn:'study','phrase-learn':'study'}[kbId];
  if (screenId) document.getElementById('screen-' + screenId)?.classList.add('kb-active');
  setTimeout(() => {
    const target = document.getElementById(KB_INPUT_MAP[kbId]);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

export function hideFrKb(kbId) {
  const kb = document.getElementById('fr-kb-' + kbId);
  if (kb) { kb.style.display = 'none'; kb.classList.remove('kb-visible'); }
  const inp = document.getElementById(KB_INPUT_MAP[kbId]);
  if (inp) { inp.removeAttribute('readonly'); inp.inputMode = frKbEnabled ? 'none' : 'text'; }
  const indicatorMap = {'learn':'learn-kb-indicator','phrase-learn':'phrase-kb-indicator'};
  if (indicatorMap[kbId]) {
    const ind = document.getElementById(indicatorMap[kbId]);
    if (ind) ind.style.display = 'none';
  }
}

export function buildFrKb(kbId) {
  const kb = document.getElementById('fr-kb-' + kbId); if (!kb || kb.dataset.built) return;
  kb.dataset.built = '1';
  const rows = [
    ['a','z','e','r','t','y','u','i','o','p'],
    ['q','s','d','f','g','h','j','k','l','m'],
    ['w','x','c','v','b','n','é','è','à','ç'],
  ];
  kb.innerHTML = rows.map(row => `<div class="fr-kb-row">${row.map(ch => `<button type="button" class="fr-key" data-ch="${ch}" onclick="window.insertFrChar?.('${kbId}', this.dataset.ch)">${ch}</button>`).join('')}</div>`).join('')
    + `<div class="fr-kb-row fr-kb-actions"><button type="button" id="fr-shift-${kbId}" class="fr-key fr-key-action" onclick="window.frToggleShift?.('${kbId}')">⇧</button><button type="button" class="fr-key fr-key-wide" onclick="window.insertFrChar?.('${kbId}', ' ')">espace</button><button type="button" class="fr-key fr-key-action" onclick="window.frBackspace?.('${kbId}')">⌫</button><button type="button" class="fr-key fr-key-action" onclick="window.frEnter?.('${kbId}')">↵</button></div>`;
}

export function initKeyboardEvents() {
  document.addEventListener('focusin', (e) => {
    const entry = Object.entries(KB_INPUT_MAP).find(([, id]) => id === e.target?.id);
    if (entry && frKbEnabled) showFrKb(entry[0]);
  });
  document.addEventListener('focusout', (e) => {
    const entry = Object.entries(KB_INPUT_MAP).find(([, id]) => id === e.target?.id);
    if (!entry) return;
    if (frKbBlurTimer) clearTimeout(frKbBlurTimer);
    frKbBlurTimer = setTimeout(() => hideFrKb(entry[0]), 160);
  });
}

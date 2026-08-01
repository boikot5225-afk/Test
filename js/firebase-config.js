// Firebase config for An II.
// ВАЖНО: это публичный web config Firebase, не service account и не приватный ключ.
window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM",
  authDomain: "french-da79a.firebaseapp.com",
  databaseURL: "https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "french-da79a",
  appId: "1:534791612002:web:e9a9a990d351ced860133b"
};

window.AN2_ADMIN_USERNAME = window.AN2_ADMIN_USERNAME || 'boikot5225';
window.AN2_FIREBASE_FUNCTIONS_REGION = window.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1';

// Emergency Firebase-compatible transport.
// It is installed immediately, before the page tries gstatic/jsDelivr.
// Therefore Email/Password login still works when those CDN scripts are blocked.
(function installImmediateFirebaseFallback() {
  if (window.firebase && typeof window.firebase.auth === 'function' && typeof window.firebase.database === 'function') return;

  const config = window.FIREBASE_CONFIG;
  const SESSION_KEY = 'an2_firebase_rest_session_v1';
  const apps = [];
  const listeners = new Set();

  function loadSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return value && value.uid && value.idToken ? value : null;
    } catch (_) { return null; }
  }
  function saveSession(value) {
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }
  function makeError(payload, fallback) {
    const raw = String((payload && payload.error && payload.error.message) || (payload && payload.message) || fallback || 'auth/network-request-failed');
    const map = {
      EMAIL_NOT_FOUND: 'auth/user-not-found',
      INVALID_PASSWORD: 'auth/wrong-password',
      INVALID_LOGIN_CREDENTIALS: 'auth/invalid-credential',
      EMAIL_EXISTS: 'auth/email-already-in-use',
      WEAK_PASSWORD: 'auth/weak-password',
      OPERATION_NOT_ALLOWED: 'auth/operation-not-allowed',
      CONFIGURATION_NOT_FOUND: 'auth/configuration-not-found',
      INVALID_EMAIL: 'auth/invalid-email'
    };
    const error = new Error(raw);
    error.code = map[raw] || fallback || 'auth/network-request-failed';
    return error;
  }

  let session = loadSession();
  let currentUser = null;
  function notify() { listeners.forEach((fn) => { try { fn(currentUser); } catch (_) {} }); }
  function makeUser(data) {
    if (!data) return null;
    return {
      uid: data.uid,
      email: data.email || '',
      async getIdToken(forceRefresh) {
        if (forceRefresh && data.refreshToken) {
          const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refreshToken });
          const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(config.apiKey), {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
          });
          const result = await res.json().catch(() => ({}));
          if (!res.ok || result.error) throw makeError(result, 'auth/network-request-failed');
          data.idToken = result.id_token || data.idToken;
          data.refreshToken = result.refresh_token || data.refreshToken;
          saveSession(data);
        }
        return data.idToken;
      }
    };
  }
  currentUser = makeUser(session);

  async function authRequest(kind, email, password) {
    const endpoint = kind === 'signup' ? 'accounts:signUp' : 'accounts:signInWithPassword';
    const res = await fetch('https://identitytoolkit.googleapis.com/v1/' + endpoint + '?key=' + encodeURIComponent(config.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email || '').trim(), password: String(password || ''), returnSecureToken: true })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.error) throw makeError(result, 'auth/network-request-failed');
    session = { uid: result.localId, email: result.email || email || '', idToken: result.idToken, refreshToken: result.refreshToken || '' };
    currentUser = makeUser(session);
    saveSession(session);
    notify();
    return { user: currentUser };
  }

  const auth = function () {
    return {
      Auth: { Persistence: { LOCAL: 'LOCAL' } },
      get currentUser() { return currentUser; },
      setPersistence: async () => {},
      onAuthStateChanged(fn) {
        listeners.add(fn);
        Promise.resolve().then(() => { try { fn(currentUser); } catch (_) {} });
        return () => listeners.delete(fn);
      },
      signInWithEmailAndPassword(email, password) { return authRequest('signin', email, password); },
      createUserWithEmailAndPassword(email, password) { return authRequest('signup', email, password); },
      signOut: async () => { session = null; currentUser = null; saveSession(null); notify(); }
    };
  };
  auth.Auth = { Persistence: { LOCAL: 'LOCAL' } };

  function databaseRef(path) {
    const clean = String(path || '').replace(/^\/+|\/+$/g, '');
    const base = String(config.databaseURL).replace(/\/+$/, '');
    const request = async (method, payload) => {
      const token = currentUser ? await currentUser.getIdToken(false) : '';
      const url = base + (clean ? '/' + clean : '') + '.json' + (token ? '?auth=' + encodeURIComponent(token) : '');
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload)
      });
      const data = method === 'DELETE' ? null : await res.json().catch(() => null);
      if (!res.ok || (data && data.error)) throw makeError(data, 'permission-denied');
      return data;
    };
    return {
      async get() { const value = await request('GET'); return { exists: () => value !== null && value !== undefined, val: () => value }; },
      set: (value) => request('PUT', value),
      update: (value) => request('PATCH', value),
      remove: () => request('DELETE')
    };
  }

  window.firebase = {
    apps,
    initializeApp() { if (!apps.length) apps.push({ name: '[DEFAULT]' }); return apps[0]; },
    app() { if (!apps.length) apps.push({ name: '[DEFAULT]' }); return apps[0]; },
    auth,
    database: () => ({ ref: databaseRef }),
    __an2RestFallback: true
  };
  window.an2FirebaseSdkReady = Promise.resolve(true);
})();

// LingQ-like reading shell. It only replaces the reader presentation layer;
// Reader AI remains responsible for books, dictionaries, AI, TTS and progress.
import('./lingq-reader-shell.js?v=0.1.0')
  .catch((error) => console.warn('[lingq reader shell] module skipped:', error));

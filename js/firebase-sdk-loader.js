// Resilient Firebase bootstrap for this branch.
const VERSION = '10.12.5';
const SDK_TIMEOUT_MS = 3500;
const REST_SESSION_KEY = 'an2_firebase_rest_session_v1';

function hasCore() { return !!globalThis.firebase?.initializeApp; }
function hasAuth() { return typeof globalThis.firebase?.auth === 'function'; }
function hasDatabase() { return typeof globalThis.firebase?.database === 'function'; }

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error(`Таймаут загрузки ${url}`));
    }, SDK_TIMEOUT_MS);
    script.src = `${url}${url.includes('?') ? '&' : '?'}an2=${Date.now()}`;
    script.async = false;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error(`Не загрузился ${url}`)); };
    document.head.appendChild(script);
  });
}

async function loadPart(part) {
  const urls = [
    `https://www.gstatic.com/firebasejs/${VERSION}/${part}-compat.js`,
    `https://cdn.jsdelivr.net/npm/firebase@${VERSION}/${part}-compat.js`,
  ];
  const results = await Promise.allSettled(urls.map(loadScript));
  if (!results.some((item) => item.status === 'fulfilled')) throw new Error(`Не удалось загрузить Firebase ${part}`);
}

function storedSession() {
  try {
    const value = JSON.parse(localStorage.getItem(REST_SESSION_KEY) || 'null');
    return value?.uid && value?.idToken ? value : null;
  } catch { return null; }
}

function saveSession(value) {
  try {
    if (value) localStorage.setItem(REST_SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(REST_SESSION_KEY);
  } catch {}
}

function firebaseError(payload, fallback = 'auth/network-request-failed') {
  const source = payload?.error || payload || {};
  const raw = String(source.message || source.code || fallback);
  const codes = {
    EMAIL_NOT_FOUND: 'auth/user-not-found',
    INVALID_PASSWORD: 'auth/wrong-password',
    INVALID_LOGIN_CREDENTIALS: 'auth/invalid-credential',
    EMAIL_EXISTS: 'auth/email-already-in-use',
    WEAK_PASSWORD: 'auth/weak-password',
    OPERATION_NOT_ALLOWED: 'auth/operation-not-allowed',
    CONFIGURATION_NOT_FOUND: 'auth/configuration-not-found',
    INVALID_EMAIL: 'auth/invalid-email',
  };
  const error = new Error(source.message || raw || 'Firebase request failed');
  error.code = codes[raw] || fallback;
  return error;
}

function installRestFallback() {
  const config = globalThis.FIREBASE_CONFIG;
  if (!config?.apiKey || !config?.databaseURL) return;

  const apps = [];
  const listeners = new Set();
  let session = storedSession();
  let currentUser = makeUser(session);

  function notify() {
    listeners.forEach((listener) => { try { listener(currentUser); } catch {} });
  }

  function makeUser(data) {
    if (!data) return null;
    return {
      uid: data.uid,
      email: data.email || '',
      async getIdToken(forceRefresh = false) {
        if (forceRefresh && data.refreshToken) {
          const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refreshToken });
          const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.error) throw firebaseError(result);
          data.idToken = result.id_token || data.idToken;
          data.refreshToken = result.refresh_token || data.refreshToken;
          saveSession(data);
        }
        return data.idToken;
      },
    };
  }

  async function authRequest(kind, email, password) {
    const action = kind === 'signup' ? 'accounts:signUp' : 'accounts:signInWithPassword';
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${action}?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw firebaseError(result);
    session = { uid: result.localId, email: result.email || email || '', idToken: result.idToken, refreshToken: result.refreshToken || '' };
    currentUser = makeUser(session);
    saveSession(session);
    notify();
    return { user: currentUser };
  }

  const authState = {
    Auth: { Persistence: { LOCAL: 'LOCAL' } },
    get currentUser() { return currentUser; },
    async setPersistence() {},
    onAuthStateChanged(listener) {
      listeners.add(listener);
      Promise.resolve().then(() => { try { listener(currentUser); } catch {} });
      return () => listeners.delete(listener);
    },
    signInWithEmailAndPassword(email, password) { return authRequest('signin', String(email || '').trim(), String(password || '')); },
    createUserWithEmailAndPassword(email, password) { return authRequest('signup', String(email || '').trim(), String(password || '')); },
    async signOut() {
      session = null;
      currentUser = null;
      saveSession(null);
      notify();
    },
  };

  function databaseUrl(path, token) {
    const base = String(config.databaseURL).replace(/\/+$/, '');
    const clean = String(path || '').replace(/^\/+|\/+$/g, '');
    const url = clean ? `${base}/${clean}.json` : `${base}/.json`;
    return token ? `${url}?auth=${encodeURIComponent(token)}` : url;
  }

  function ref(path = '') {
    async function request(method, payload) {
      const token = currentUser ? await currentUser.getIdToken(false) : '';
      const response = await fetch(databaseUrl(path, token), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const result = method === 'DELETE' ? null : await response.json().catch(() => null);
      if (!response.ok || result?.error) throw firebaseError(result, 'permission-denied');
      return result;
    }
    return {
      async get() {
        const value = await request('GET');
        return { exists: () => value !== null && value !== undefined, val: () => value };
      },
      async set(value) { await request('PUT', value); },
      async update(value) { await request('PATCH', value); },
      async remove() { await request('DELETE'); },
    };
  }

  const app = { name: '[DEFAULT]' };
  const authFactory = () => authState;
  authFactory.Auth = authState.Auth;
  const fallback = {
    apps,
    initializeApp() { if (!apps.length) apps.push(app); return app; },
    app() { if (!apps.length) apps.push(app); return app; },
    auth: authFactory,
    database: () => ({ ref }),
  };

  if (!globalThis.firebase) {
    globalThis.firebase = fallback;
  } else {
    if (!globalThis.firebase.apps) globalThis.firebase.apps = fallback.apps;
    if (!globalThis.firebase.initializeApp) globalThis.firebase.initializeApp = fallback.initializeApp;
    if (!globalThis.firebase.app) globalThis.firebase.app = fallback.app;
    if (!globalThis.firebase.auth) globalThis.firebase.auth = fallback.auth;
    if (!globalThis.firebase.database) globalThis.firebase.database = fallback.database;
  }
}

try {
  if (!hasCore()) await loadPart('firebase-app');
  if (!hasAuth()) await loadPart('firebase-auth');
  if (!hasDatabase()) await loadPart('firebase-database');
} catch (error) {
  console.warn('[firebase bootstrap]', error?.message || error);
}

if (!hasCore() || !hasAuth() || !hasDatabase()) installRestFallback();

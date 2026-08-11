window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM',
  authDomain: 'french-da79a.firebaseapp.com',
  databaseURL: 'https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'french-da79a',
  appId: '1:534791612002:web:e9a9a990d351ced860133b',
};
window.AN2_ADMIN_USERNAME = 'boikot5225';
window.AN2_FIREBASE_FUNCTIONS_REGION = 'asia-southeast1';
window.AN2_AUTH_BOOTSTRAP = 'reader-auth-v71.7';

(function installFirebaseRestFallback() {
  const config = window.FIREBASE_CONFIG;
  const SESSION_KEY = 'an2_firebase_rest_session_v1';
  const apps = [];
  const listeners = new Set();
  const base = new URL('.', document.currentScript?.src || location.href);
  const isNativeAndroid = location.hostname === 'appassets.androidplatform.net';

  let session;
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session?.uid || !session?.idToken) session = null;
  } catch (_) {
    session = null;
  }
  let user = null;

  function firebaseError(payload, fallbackCode) {
    const source = payload?.error || payload || {};
    const raw = String(source.message || source.code || fallbackCode || 'auth/network-request-failed');
    const authCodes = {
      EMAIL_NOT_FOUND: 'auth/user-not-found',
      INVALID_PASSWORD: 'auth/wrong-password',
      INVALID_LOGIN_CREDENTIALS: 'auth/invalid-credential',
      EMAIL_EXISTS: 'auth/email-already-in-use',
      WEAK_PASSWORD: 'auth/weak-password',
      OPERATION_NOT_ALLOWED: 'auth/operation-not-allowed',
      CONFIGURATION_NOT_FOUND: 'auth/configuration-not-found',
      INVALID_EMAIL: 'auth/invalid-email',
    };
    const error = new Error(source.message || raw || fallbackCode || 'Firebase request failed');
    error.code = authCodes[raw] || fallbackCode || 'auth/network-request-failed';
    if (source.details !== undefined) error.details = source.details;
    return error;
  }

  function callableError(payload, statusCode = 0) {
    const source = payload?.error || payload || {};
    const status = String(source.status || '').trim().toLowerCase().replace(/_/g, '-');
    const code = status ? `functions/${status}` : `functions/${statusCode === 401 ? 'unauthenticated' : 'internal'}`;
    const error = new Error(source.message || `Firebase callable failed (${statusCode || 'network'})`);
    error.code = code;
    if (source.details !== undefined) error.details = source.details;
    return error;
  }

  function saveSession() {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  function emitAuthState() {
    listeners.forEach((listener) => {
      try { listener(user); } catch (_) {}
    });
  }

  function makeUser(data) {
    if (!data) return null;
    return {
      uid: data.uid,
      email: data.email || '',
      async getIdToken(forceRefresh = false) {
        if (forceRefresh && data.refreshToken) {
          const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: data.refreshToken,
          });
          const response = await fetch(
            `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body,
            },
          );
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.error) throw firebaseError(result);
          data.idToken = result.id_token || data.idToken;
          data.refreshToken = result.refresh_token || data.refreshToken;
          session = data;
          saveSession();
        }
        return data.idToken;
      },
    };
  }

  user = makeUser(session);

  async function sign(up, email, password) {
    const action = up ? 'accounts:signUp' : 'accounts:signInWithPassword';
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/${action}?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(email || '').trim(),
          password: String(password || ''),
          returnSecureToken: true,
        }),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw firebaseError(result);
    session = {
      uid: result.localId,
      email: result.email || email || '',
      idToken: result.idToken,
      refreshToken: result.refreshToken || '',
    };
    user = makeUser(session);
    saveSession();
    emitAuthState();
    return { user };
  }

  const authState = {
    Auth: { Persistence: { LOCAL: 'LOCAL' } },
    get currentUser() { return user; },
    async setPersistence() {},
    onAuthStateChanged(listener) {
      listeners.add(listener);
      Promise.resolve().then(() => {
        try { listener(user); } catch (_) {}
      });
      return () => listeners.delete(listener);
    },
    signInWithEmailAndPassword: (email, password) => sign(false, email, password),
    createUserWithEmailAndPassword: (email, password) => sign(true, email, password),
    async signOut() {
      session = null;
      user = null;
      saveSession();
      emitAuthState();
    },
  };
  const auth = () => authState;
  auth.Auth = authState.Auth;

  function ref(path = '') {
    const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
    async function request(method, value) {
      const token = user ? await user.getIdToken(false) : '';
      const url = `${config.databaseURL.replace(/\/+$/, '')}${cleanPath ? `/${cleanPath}` : ''}.json${token ? `?auth=${encodeURIComponent(token)}` : ''}`;
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: value === undefined ? undefined : JSON.stringify(value),
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
      set: (value) => request('PUT', value),
      update: (value) => request('PATCH', value),
      remove: () => request('DELETE'),
    };
  }

  function callableEndpoint(region, name) {
    const safeRegion = String(region || window.AN2_FIREBASE_FUNCTIONS_REGION || 'us-central1').trim();
    const safeName = String(name || '').trim();
    if (!safeName || !/^[A-Za-z0-9_-]+$/.test(safeName)) {
      throw new Error('Некорректное имя Firebase Callable Function.');
    }
    return `https://${safeRegion}-${config.projectId}.cloudfunctions.net/${safeName}`;
  }

  async function callFunction(region, name, payload, allowRefreshRetry = true) {
    const token = user ? await user.getIdToken(false) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(callableEndpoint(region, name), {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: payload }),
    });
    const result = await response.json().catch(() => ({}));

    const unauthenticated = response.status === 401 || String(result?.error?.status || '').toUpperCase() === 'UNAUTHENTICATED';
    if (unauthenticated && allowRefreshRetry && user && session?.refreshToken) {
      await user.getIdToken(true);
      return callFunction(region, name, payload, false);
    }
    if (!response.ok || result?.error) throw callableError(result, response.status);

    if (Object.prototype.hasOwnProperty.call(result, 'result')) return { data: result.result };
    // Some local/emulator/proxy implementations expose `data`; accepting it is
    // harmless and keeps the fallback compatible with those environments.
    if (Object.prototype.hasOwnProperty.call(result, 'data')) return { data: result.data };
    throw callableError({ error: { status: 'INTERNAL', message: 'Firebase callable response has no result.' } }, response.status);
  }

  function functions(region = window.AN2_FIREBASE_FUNCTIONS_REGION || 'us-central1') {
    return {
      httpsCallable(name) {
        return (payload) => callFunction(region, name, payload);
      },
    };
  }

  const app = { name: '[DEFAULT]' };
  // The native shell deliberately skips remote Firebase compat scripts during
  // startup. Give its local fallback the Functions compat surface too, so
  // readerAI keeps working without re-introducing a parser-blocking CDN fetch.
  if (isNativeAndroid) app.functions = functions;

  const firebaseFallback = {
    apps,
    initializeApp() {
      if (!apps.length) apps.push(app);
      return apps[0];
    },
    app() {
      if (!apps.length) apps.push(app);
      return apps[0];
    },
    auth,
    database: () => ({ ref }),
    __an2RestFallback: true,
  };
  if (isNativeAndroid) firebaseFallback.functions = functions;

  function install() {
    window.firebase = firebaseFallback;
  }

  install();
  window.__AN2_FALLBACK_FIREBASE = firebaseFallback;
  window.an2FirebaseSdkReady = Promise.resolve(true);

  window.addEventListener('DOMContentLoaded', () => setTimeout(async () => {
    try {
      const module = await import(new URL('supabase.js', base).href);
      if (!module.isSupabaseReady()) {
        install();
        module.initSupabase();
      }
      console.warn('[an2 auth ready]', module.isSupabaseReady?.());
    } catch (error) {
      console.error('[an2 auth repair]', error);
    }
  }, 0), { once: true });
})();

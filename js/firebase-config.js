// Firebase config and self-contained auth adapter for the deployed reader branch.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM",
  authDomain: "french-da79a.firebaseapp.com",
  databaseURL: "https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "french-da79a",
  appId: "1:534791612002:web:e9a9a990d351ced860133b"
};
window.AN2_ADMIN_USERNAME = 'boikot5225';
window.AN2_FIREBASE_FUNCTIONS_REGION = 'asia-southeast1';
window.AN2_AUTH_BOOTSTRAP = 'reader-auth-v71.6';

(function () {
  const config = window.FIREBASE_CONFIG;
  const baseUrl = new URL('.', document.currentScript && document.currentScript.src ? document.currentScript.src : location.href);
  const SESSION_KEY = 'an2_firebase_rest_session_v1';
  const apps = [];
  const listeners = new Set();

  function readSession() {
    try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return s && s.uid && s.idToken ? s : null; }
    catch (_) { return null; }
  }
  function saveSession(s) {
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }
  function errorFrom(payload, fallback) {
    const raw = String((payload && payload.error && payload.error.message) || (payload && payload.message) || fallback || 'auth/network-request-failed');
    const codes = { EMAIL_NOT_FOUND:'auth/user-not-found', INVALID_PASSWORD:'auth/wrong-password', INVALID_LOGIN_CREDENTIALS:'auth/invalid-credential', EMAIL_EXISTS:'auth/email-already-in-use', WEAK_PASSWORD:'auth/weak-password', OPERATION_NOT_ALLOWED:'auth/operation-not-allowed', CONFIGURATION_NOT_FOUND:'auth/configuration-not-found', INVALID_EMAIL:'auth/invalid-email' };
    const e = new Error(raw); e.code = codes[raw] || fallback || 'auth/network-request-failed'; return e;
  }

  let session = readSession();
  let currentUser = null;
  function emit() { listeners.forEach(fn => { try { fn(currentUser); } catch (_) {} }); }
  function makeUser(s) {
    if (!s) return null;
    return {
      uid: s.uid,
      email: s.email || '',
      async getIdToken(forceRefresh) {
        if (forceRefresh && s.refreshToken) {
          const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
          const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(config.apiKey), { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.error) throw errorFrom(j, 'auth/network-request-failed');
          s.idToken = j.id_token || s.idToken; s.refreshToken = j.refresh_token || s.refreshToken; saveSession(s);
        }
        return s.idToken;
      }
    };
  }
  currentUser = makeUser(session);

  async function sign(kind, email, password) {
    const endpoint = kind === 'up' ? 'accounts:signUp' : 'accounts:signInWithPassword';
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/' + endpoint + '?key=' + encodeURIComponent(config.apiKey), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email:String(email || '').trim(), password:String(password || ''), returnSecureToken:true })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw errorFrom(j, 'auth/network-request-failed');
    session = { uid:j.localId, email:j.email || email || '', idToken:j.idToken, refreshToken:j.refreshToken || '' };
    currentUser = makeUser(session); saveSession(session); emit();
    return { user: currentUser };
  }

  const authState = {
    Auth: { Persistence: { LOCAL: 'LOCAL' } },
    get currentUser() { return currentUser; },
    async setPersistence() {},
    onAuthStateChanged(fn) { listeners.add(fn); Promise.resolve().then(() => { try { fn(currentUser); } catch (_) {} }); return () => listeners.delete(fn); },
    signInWithEmailAndPassword(email, password) { return sign('in', email, password); },
    createUserWithEmailAndPassword(email, password) { return sign('up', email, password); },
    async signOut() { session = null; currentUser = null; saveSession(null); emit(); }
  };
  const auth = () => authState;
  auth.Auth = authState.Auth;

  function ref(path) {
    const clean = String(path || '').replace(/^\/+|\/+$/g, '');
    async function request(method, payload) {
      const token = currentUser ? await currentUser.getIdToken(false) : '';
      const url = String(config.databaseURL).replace(/\/+$/, '') + (clean ? '/' + clean : '') + '.json' + (token ? '?auth=' + encodeURIComponent(token) : '');
      const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload) });
      const j = method === 'DELETE' ? null : await r.json().catch(() => null);
      if (!r.ok || (j && j.error)) throw errorFrom(j, 'permission-denied');
      return j;
    }
    return {
      async get() { const value = await request('GET'); return { exists: () => value !== null && value !== undefined, val: () => value }; },
      set: value => request('PUT', value), update: value => request('PATCH', value), remove: () => request('DELETE')
    };
  }

  const adapter = {
    apps,
    initializeApp() { if (!apps.length) apps.push({ name:'[DEFAULT]' }); return apps[0]; },
    app() { if (!apps.length) apps.push({ name:'[DEFAULT]' }); return apps[0]; },
    auth,
    database: () => ({ ref }),
    __an2RestFallback: true
  };

  function install() { window.firebase = adapter; }
  install();
  window.__AN2_FALLBACK_FIREBASE = adapter;
  window.an2FirebaseSdkReady = Promise.resolve(true);

  // The CDN compatibility scripts can overwrite window.firebase midway through parsing.
  // Reinstall the known-good adapter after module scripts have run, then re-run initSupabase
  // so the exact closure used by doLogin sees firebaseReady=true.
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(async () => {
      try {
        install();
        const api = await import(new URL('supabase.js?v=71.6-auth-repair', baseUrl).href);
        api.initSupabase();
        console.warn('[an2 auth] repaired:', api.isSupabaseReady && api.isSupabaseReady());
      } catch (e) {
        console.error('[an2 auth] repair failed:', e);
      }
    }, 0);
  }, { once:true });
})();

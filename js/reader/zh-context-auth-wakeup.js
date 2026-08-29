// toc100: wake the contextual Chinese batch when Firebase restores a user.
// Native Android can paint before the persisted auth session is ready; toc98/99
// checked currentUser once and could stay silent until some unrelated UI event.

let bound = false;
let attempts = 0;

function wake(source) {
  try {
    window.dispatchEvent(new CustomEvent('reader:zh-resource-ready', {
      detail: { source: source || 'firebase-auth' },
    }));
  } catch {}
}

function bind() {
  if (bound || typeof window === 'undefined') return;
  const authFactory = globalThis.firebase?.auth;
  if (typeof authFactory !== 'function') {
    if (attempts++ < 100) setTimeout(bind, 100);
    return;
  }
  let auth = null;
  try { auth = authFactory(); } catch {}
  if (!auth || typeof auth.onAuthStateChanged !== 'function') {
    if (attempts++ < 100) setTimeout(bind, 100);
    return;
  }
  bound = true;
  auth.onAuthStateChanged(user => {
    if (user?.uid) wake('firebase-auth-ready');
  });
  if (auth.currentUser?.uid) wake('firebase-auth-current');
}

bind();

export { bind };

// Runs as a deferred module before app.js.
// The classic Firebase CDN scripts may partially replace the fallback object.
// The app uses this stable adapter for Auth + Realtime Database instead.
const fallback = window.__AN2_FALLBACK_FIREBASE;
if (fallback) {
  window.firebase = fallback;
  window.AN2_AUTH_BOOTSTRAP = 'reader-auth-v71.5';
  console.warn('[an2 auth] stable adapter selected');
} else {
  console.error('[an2 auth] fallback adapter was not created');
}

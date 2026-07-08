// An II service worker.
const CACHE_VERSION = 'v76.81-fix-word-sync-debounce';
const CACHE_NAME = `an2-cache-${CACHE_VERSION}`;
const fromScope = (path = '') => new URL(path, self.registration.scope).toString();
const CORE_ASSETS = [
  '', 'index.html', 'css/style.css', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'js/app.js', 'js/dict.js', 'js/groups.js', 'js/home.js', 'js/numbers.js',
  'js/phrases.js', 'js/srs.js', 'js/state.js', 'js/stats.js', 'js/storage.js',
  'js/study.js', 'js/supabase.js', 'js/firebase-config.js', 'js/firebase-sdk-loader.js', 'js/firebase-db.js',
  'js/trainer.js', 'js/tts.js', 'js/utils.js', 'js/reader-app.js', 'js/dict-render.js', 'js/exercises-fr.js',
  'js/reader/image-store.js', 'js/reader/audio-store.js', 'js/reader/library-idb-store.js',
  'js/reader/word-state-idb-store.js', 'js/reader/lexical-cache-idb-store.js',
  'js/lang-separation.js', 'js/lang-core.js', 'js/lang-reader.js', 'js/lang-personal-verbs.js',
  'firebase-test.html', 'tts-test.html', 'firebase-import.html',
  'firebase/firebase-rules.json', 'firebase/firebase-seed-root.json', 'firebase/seed-verbs.json'
].map(fromScope);
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await Promise.allSettled(CORE_ASSETS.map(async (asset) => {
      try { await cache.add(asset); } catch (error) { console.warn('[sw] precache skipped:', asset, error); }
    }));
  }));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('an2-cache-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(req, { cache: 'no-store' }).then((res) => {
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req).then((cached) => cached || caches.match(fromScope('index.html')))));
});

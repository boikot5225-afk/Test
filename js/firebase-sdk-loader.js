// Loads Firebase compat SDK parts before firebase-db.js starts.
// index.html already tries first; this is the awaited retry path when one
// Firebase CDN tag failed or arrived without Auth/Database.
const VERSION = '10.12.5';

function hasCore() {
  return !!globalThis.firebase?.initializeApp;
}

function hasAuth() {
  return typeof globalThis.firebase?.auth === 'function';
}

function hasDatabase() {
  return typeof globalThis.firebase?.database === 'function';
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // A unique query avoids attaching to an earlier tag that already failed.
    script.src = `${url}${url.includes('?') ? '&' : '?'}an2retry=${Date.now()}`;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Не загрузился ${url}`));
    document.head.appendChild(script);
  });
}

async function loadCompat(moduleName) {
  const urls = [
    `https://www.gstatic.com/firebasejs/${VERSION}/${moduleName}-compat.js`,
    `https://cdn.jsdelivr.net/npm/firebase@${VERSION}/${moduleName}-compat.js`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      await loadScript(url);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Не загрузился Firebase ${moduleName}`);
}

try {
  if (!hasCore()) await loadCompat('firebase-app');
  if (!hasAuth()) await loadCompat('firebase-auth');
  if (!hasDatabase()) await loadCompat('firebase-database');
} catch (error) {
  console.warn('[firebase loader]', error?.message || error);
}

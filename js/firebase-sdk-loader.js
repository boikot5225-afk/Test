// Loads Firebase compat SDK parts before firebase-db.js starts.
// index.html already tries first; this is the second, awaited path for cases
// where gstatic/jsdelivr was late or one of the auth/database modules failed.
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
    const existing = [...document.scripts].find((script) => script.src === url);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error(`Не загрузился ${url}`)), { once: true });
      if (existing.dataset.an2Loaded === '1') resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    script.onload = () => { script.dataset.an2Loaded = '1'; resolve(); };
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

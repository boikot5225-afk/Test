from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(s.replace(old, new, 1))


# toc115: Chinese DeepSeek must fill ONLY genuinely blank Unknown glosses, and
# Android must use whichever Firebase client actually owns the persisted auth
# session (real compat SDK or the native REST fallback).

reader_ai_old = '''async function readerAI(payload) {
  // v67: reader-ai переехал с Supabase Edge Function в Firebase Callable Function.
  // Контракт с остальным приложением сохраняем прежним: на вход task/payload, на выход готовый JSON.
  if (!globalThis.firebase?.app) {
    throw new Error('Firebase SDK не загружен. Проверь index.html и доступ к gstatic/jsdelivr.');
  }
  if (!globalThis.firebase?.functions) {
    throw new Error('Firebase Functions SDK не загружен. В index.html должен быть firebase-functions-compat.js.');
  }

  try { if (!isSupabaseReady()) initSupabase(); } catch {}

  const task = String(payload?.task || '').trim();
  if (!task) throw new Error('readerAI: пустой task.');

  try {
    const fn = globalThis.firebase.app().functions(readerFunctionRegion()).httpsCallable('readerAI');
'''
reader_ai_new = '''function readerFirebaseClientWithAuthenticatedCallable() {
  const candidates = [globalThis.firebase, globalThis.__AN2_FALLBACK_FIREBASE].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const auth = typeof candidate.auth === 'function' ? candidate.auth() : null;
      const app = typeof candidate.app === 'function' ? candidate.app() : null;
      if (auth?.currentUser && typeof app?.functions === 'function') return candidate;
    } catch {}
  }
  return globalThis.firebase || globalThis.__AN2_FALLBACK_FIREBASE || null;
}

async function readerAI(payload) {
  // v67: reader-ai переехал с Supabase Edge Function в Firebase Callable Function.
  // Контракт с остальным приложением сохраняем прежним: на вход task/payload, на выход готовый JSON.
  const firebaseClient = readerFirebaseClientWithAuthenticatedCallable();
  if (!firebaseClient?.app) {
    throw new Error('Firebase SDK не загружен. Проверь index.html и доступ к gstatic/jsdelivr.');
  }

  try { if (!isSupabaseReady()) initSupabase(); } catch {}

  const task = String(payload?.task || '').trim();
  if (!task) throw new Error('readerAI: пустой task.');

  try {
    const app = firebaseClient.app();
    if (typeof app?.functions !== 'function') {
      throw new Error('Firebase Functions недоступны в активном auth-клиенте.');
    }
    const fn = app.functions(readerFunctionRegion()).httpsCallable('readerAI');
'''
replace_once('js/reader-app.js', reader_ai_old, reader_ai_new, 'authenticated readerAI client selection')

old_auth = '''function firebaseUserReady() {
  try {
    const firebase = globalThis.firebase;
    if (!firebase) return false;
    const auth = typeof firebase.auth === 'function' ? firebase.auth() : firebase.app?.()?.auth?.();
    return !!auth?.currentUser;
  } catch { return false; }
}
'''
new_auth = '''function firebaseClientWithAuth() {
  const candidates = [globalThis.firebase, globalThis.__AN2_FALLBACK_FIREBASE].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const auth = typeof candidate.auth === 'function' ? candidate.auth() : null;
      const app = typeof candidate.app === 'function' ? candidate.app() : null;
      if (auth?.currentUser && typeof app?.functions === 'function') return candidate;
    } catch {}
  }
  return null;
}

function firebaseUserReady() {
  return !!firebaseClientWithAuth();
}
'''
replace_once('js/reader/zh-context-batch.js', old_auth, new_auth, 'batch auth client selection')

old_call = '''async function callBatch(context, occurrences) {
  const firebase = globalThis.firebase;
  if (!firebase?.app) throw new Error('Firebase недоступен');
  const fn = firebase.app().functions(functionRegion()).httpsCallable('readerAI');
'''
new_call = '''async function callBatch(context, occurrences) {
  const firebase = firebaseClientWithAuth();
  if (!firebase?.app) throw new Error('Firebase Auth недоступен для DeepSeek batch');
  const fn = firebase.app().functions(functionRegion()).httpsCallable('readerAI');
'''
replace_once('js/reader/zh-context-batch.js', old_call, new_call, 'batch uses authenticated client')

old_unknown_check = "    if (!word.classList.contains('rw-migaku-unknown')) return;\n"
new_unknown_check = '''    const explicitlyUnknown = String(word.dataset.readerManualKnowledge || '').toLowerCase() === 'unknown';
    const isUnknown = word.classList.contains('rw-migaku-unknown')
      || word.classList.contains('rw-problem')
      || explicitlyUnknown;
    if (!isUnknown) return;
'''
replace_once('js/reader/zh-context-batch.js', old_unknown_check, new_unknown_check, 'cover manual Unknown before class bridge')

request_anchor = '''function requestCandidates(all, mode) {
  const eligible = all.filter(item => {
'''
request_new = '''function existingRussianForOccurrence(item) {
  const wrap = item?.wrap;
  if (!wrap) return '';
  const meaning = wrap.querySelector?.(':scope > .rw-zh-readable-ru .rw-zh-readable-meaning');
  const candidates = [
    meaning?.textContent,
    wrap.dataset.zhGlossContextRu,
    wrap.dataset.zhGlossStickyRu,
    wrap.dataset.zhGlossRuReadable,
    wrap.dataset.zhGlossRu,
  ];
  for (const raw of candidates) {
    const value = clean(raw, 120);
    if (value && /[\\u0400-\\u052f]/.test(value)) return value;
  }
  return '';
}

function needsDeepSeek(item) {
  return !existingRussianForOccurrence(item);
}

function requestCandidates(all, mode) {
  const eligible = all.filter(item => {
    if (!needsDeepSeek(item)) return false;
'''
replace_once('js/reader/zh-context-batch.js', request_anchor, request_new, 'DeepSeek only for blank Russian slots')

replace_once(
    'js/reader/zh-context-batch.js',
    'const RESOURCE_SETTLE_MS = 110;\n',
    'const RESOURCE_SETTLE_MS = 420;\n',
    'allow local translation to settle before paid batch',
)

old_settle_call = '''    await new Promise(resolve => setTimeout(resolve, RESOURCE_SETTLE_MS));
    const items = await callBatch(context, batch);
    const byId = new Map(items.map(item => [clean(item?.id, 40), item]));
    let changed = false;
    let cacheChanged = false;

    for (const occurrence of batch) {
'''
new_settle_call = '''    await new Promise(resolve => setTimeout(resolve, RESOURCE_SETTLE_MS));
    const stillMissing = batch.filter(needsDeepSeek);
    for (const occurrence of batch) {
      if (stillMissing.includes(occurrence)) continue;
      state.inFlight.delete(occurrence.cacheKey);
      delete occurrence.wrap?.dataset?.zhContextPending;
    }
    if (!stillMissing.length) return false;

    const items = await callBatch(context, stillMissing);
    const byId = new Map(items.map(item => [clean(item?.id, 40), item]));
    let changed = false;
    let cacheChanged = false;

    for (const occurrence of stillMissing) {
'''
replace_once('js/reader/zh-context-batch.js', old_settle_call, new_settle_call, 'recheck blank slots before paid call')

replace_once(
    'js/reader/zh-context-batch.js',
    'const MAX_TARGETS = 24;\nconst RETRY_BATCH_TARGETS = 10;\n',
    'const MAX_TARGETS = 16;\nconst RETRY_BATCH_TARGETS = 8;\n',
    'safer batch size without per-word calls',
)

replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-context-batch.js?v=5-page-coverage'; // toc113: page-turn wakeup + full 24-target coverage\n",
    "import './zh-context-batch.js?v=6-missing-only-auth'; // toc115: blank Unknowns only + authenticated Firebase client\n",
    'bust context batch toc115',
)
replace_once(
    'js/app.js',
    "} from './reader-app.js?v=77.39-zh-core-first';\n",
    "} from './reader-app.js?v=77.40-zh-missing-only-auth';\n",
    'bust reader app toc115',
)
replace_once(
    'index.html',
    "window.AN2_BUILD = 'v77.42-toc114-zh-core-first';",
    "window.AN2_BUILD = 'v77.42-toc115-zh-missing-only-auth';",
    'bump toc115 marker',
)
replace_once(
    'index.html',
    '<script type="module" src="js/app.js?v=77.38-zh-core-first"></script>',
    '<script type="module" src="js/app.js?v=77.39-zh-missing-only-auth"></script>',
    'bust toc115 app entry',
)

# The lexical-v2 patch runs immediately after toc115 in the dedicated build.
# toc113 has already bumped readable-inline to v8; toc112 bumped direct-RU to
# v2. Normalize only cache-bust labels here; module contents are untouched.
replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-readable-inline.js?v=8-context-coverage';\n",
    "import './zh-readable-inline.js?v=6';\n",
    'normalize readable-inline cache-bust for lexical-v2 handoff',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-direct-ru-fallback.js?v=2-context-priority'; // context card/batch outrank raw ML Kit\n",
    "import './zh-direct-ru-fallback.js?v=1'; // toc100: direct on-device Chinese -> Russian for every visible Unknown\n",
    'normalize direct-RU cache-bust for lexical-v2 handoff',
)

print('toc115 Chinese missing-only DeepSeek/auth bridge applied')

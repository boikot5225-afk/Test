import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync('js/firebase-config.js', 'utf8');
const calls = [];

function base64url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const expiredToken = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: 'test-user', exp: Math.floor(Date.now() / 1000) - 120 })}.sig`;
const freshToken = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: 'test-user', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const store = new Map([
  ['an2_firebase_rest_session_v1', JSON.stringify({
    uid: 'test-user',
    email: 'test@example.com',
    idToken: expiredToken,
    refreshToken: 'test-refresh-token',
  })],
]);

const localStorage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(key, String(value)); },
  removeItem(key) { store.delete(key); },
};

const document = {
  currentScript: { src: 'https://appassets.androidplatform.net/assets/www/js/firebase-config.js' },
};

async function fetch(url, options = {}) {
  calls.push({ url: String(url), options });
  if (String(url).includes('securetoken.googleapis.com/v1/token')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id_token: freshToken,
          refresh_token: 'test-refresh-token-2',
          expires_in: '3600',
          user_id: 'test-user',
        };
      },
    };
  }
  if (String(url).includes('.cloudfunctions.net/readerAI')) {
    assert.equal(options?.headers?.Authorization, `Bearer ${freshToken}`, 'callable must use refreshed ID token');
    const request = JSON.parse(options?.body || '{}')?.data || {};
    const ru = request.task === 'translate_paragraph'
      ? 'Ну, раз так, проблемы нет, — сказал Буэнавентура.'
      : 'нашёл';
    return {
      ok: true,
      status: 200,
      async json() { return { result: { data: { ru } } }; },
    };
  }
  throw new Error(`unexpected fetch in fallback test: ${url}`);
}

const context = {
  console,
  URL,
  URLSearchParams,
  Promise,
  setTimeout,
  clearTimeout,
  localStorage,
  document,
  location: {
    href: 'https://appassets.androidplatform.net/assets/www/index.html',
    hostname: 'appassets.androidplatform.net',
  },
  fetch,
  atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
  addEventListener() {},
};
context.window = context;
context.globalThis = context;

vm.createContext(context);
vm.runInContext(source, context, { filename: 'firebase-config.js' });

assert.equal(typeof context.firebase, 'object', 'firebase fallback should exist');
assert.equal(typeof context.firebase.functions, 'function', 'firebase.functions fallback is missing');
const app = context.firebase.app();
assert.equal(typeof app.functions, 'function', 'firebase.app().functions fallback is missing');

// Exact path used by tts.js: getIdToken(false) must silently refresh an
// expired JWT instead of handing the expired token to ttsAudio.
const tokenFromNormalGetter = await context.firebase.auth().currentUser.getIdToken(false);
assert.equal(tokenFromNormalGetter, freshToken, 'getIdToken(false) must transparently refresh an expired JWT');
assert.equal(calls.filter((call) => call.url.includes('securetoken.googleapis.com/v1/token')).length, 1, 'expired token should be refreshed exactly once');

const callable = app.functions('asia-southeast1').httpsCallable('readerAI');
assert.equal(typeof callable, 'function', 'httpsCallable(readerAI) should be a function');

const wordPayload = { task: 'reader_word', word: 'chercha', sourceLang: 'fr' };
const wordResult = await callable(wordPayload);
assert.equal(wordResult?.data?.data?.ru, 'нашёл', 'reader_word result shape must match Firebase compat SDK');

// Exact AI task used when tapping/auto-translating a paragraph in the reader.
const paragraphPayload = {
  task: 'translate_paragraph',
  text: "Enfin, comme ça, il n'y a pas de problème, dit Buenaventura.",
  sourceLang: 'fr',
  targetLang: 'ru',
};
const paragraphResult = await callable(paragraphPayload);
assert.equal(
  paragraphResult?.data?.data?.ru,
  'Ну, раз так, проблемы нет, — сказал Буэнавентура.',
  'translate_paragraph must survive the same refreshed native session used by TTS',
);

const functionCalls = calls.filter((call) => call.url.includes('.cloudfunctions.net/readerAI'));
assert.equal(functionCalls.length, 2, 'word + paragraph should make two callable requests after one proactive refresh');
for (const call of functionCalls) {
  assert.equal(
    call.url,
    'https://asia-southeast1-french-da79a.cloudfunctions.net/readerAI',
    'callable endpoint is wrong',
  );
  assert.equal(call.options?.method, 'POST');
  assert.equal(call.options?.headers?.['Content-Type'], 'application/json');
  assert.equal(call.options?.headers?.Authorization, `Bearer ${freshToken}`);
}
assert.deepEqual(JSON.parse(functionCalls[0].options?.body || '{}'), { data: wordPayload });
assert.deepEqual(JSON.parse(functionCalls[1].options?.body || '{}'), { data: paragraphPayload });
assert.equal(
  calls.filter((call) => call.url.includes('securetoken.googleapis.com/v1/token')).length,
  1,
  'TTS/word/paragraph must share one refreshed session instead of refreshing repeatedly',
);

const saved = JSON.parse(store.get('an2_firebase_rest_session_v1') || '{}');
assert.equal(saved.idToken, freshToken, 'refreshed token must be persisted for TTS/database/callables');
assert.equal(saved.refreshToken, 'test-refresh-token-2', 'rotated refresh token must be persisted');

console.log('firebase native TTS + reader word + paragraph auth refresh: PASS');

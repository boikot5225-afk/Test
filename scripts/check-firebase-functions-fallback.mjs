import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync('js/firebase-config.js', 'utf8');
const calls = [];
const store = new Map([
  ['an2_firebase_rest_session_v1', JSON.stringify({
    uid: 'test-user',
    email: 'test@example.com',
    idToken: 'test-id-token',
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
  if (String(url).includes('.cloudfunctions.net/readerAI')) {
    return {
      ok: true,
      status: 200,
      async json() { return { result: { data: { ru: 'нашёл' } } }; },
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

const callable = app.functions('asia-southeast1').httpsCallable('readerAI');
assert.equal(typeof callable, 'function', 'httpsCallable(readerAI) should be a function');
const payload = { task: 'reader_word', word: 'chercha', sourceLang: 'fr' };
const result = await callable(payload);
assert.equal(result?.data?.data?.ru, 'нашёл', 'callable result shape must match Firebase compat SDK');

assert.equal(calls.length, 1, 'readerAI should make exactly one callable request');
const call = calls[0];
assert.equal(
  call.url,
  'https://asia-southeast1-french-da79a.cloudfunctions.net/readerAI',
  'callable endpoint is wrong',
);
assert.equal(call.options?.method, 'POST');
assert.equal(call.options?.headers?.['Content-Type'], 'application/json');
assert.equal(call.options?.headers?.Authorization, 'Bearer test-id-token');
assert.deepEqual(JSON.parse(call.options?.body || '{}'), { data: payload });

console.log('firebase callable REST fallback: PASS');

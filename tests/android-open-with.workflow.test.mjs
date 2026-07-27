import fs from 'node:fs/promises';

function assert(name, condition) {
  if (!condition) throw new Error(name);
  console.log(`✓ ${name}`);
}

const workflow = await fs.readFile(
  new URL('../.github/workflows/reader-stage1-android-apk.yml', import.meta.url),
  'utf8',
);
const externalImport = await fs.readFile(
  new URL('../js/reader/android-external-import.js', import.meta.url),
  'utf8',
);
const readerApp = await fs.readFile(
  new URL('../js/reader-app.js', import.meta.url),
  'utf8',
);

assert('Android registers VIEW intents', workflow.includes('android.intent.action.VIEW'));
assert('Android registers SEND intents', workflow.includes('android.intent.action.SEND'));
assert('EPUB MIME is registered', workflow.includes('application/epub+zip'));
assert('FB2 MIME is registered', workflow.includes('application/x-fictionbook+xml'));
assert('TXT MIME is registered', workflow.includes('text/plain'));
assert('content and file URI schemes are registered', workflow.includes('android:scheme="content"') && workflow.includes('android:scheme="file"'));
assert('new intents are handled without recreating the task', workflow.includes('onNewIntent(Intent intent)') && workflow.includes('android:launchMode="singleTask"'));
assert('native URI is streamed instead of Base64 encoded', workflow.includes('openInputStream(uri)') && !workflow.includes('Base64.'));
assert('WebView external-import endpoint is intercepted', workflow.includes('/android-import/current'));
assert('external importer invokes the real routed handler', externalImport.includes('__real_readerImportFromFile'));
assert('external import automatically saves and opens the book', externalImport.includes('saveHandler()'));
assert('FB2 is accepted by the file picker', readerApp.includes('.epub,.fb2'));
assert('FB2 has a real XML parser path', readerApp.includes("parseFromString(xml, 'application/xml')"));

console.log('android open-with workflow: OK');

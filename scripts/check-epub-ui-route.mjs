import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Execute the production event owner with fake parser/storage dependencies.
// This checks routing/races, not EPUB decoding or Android's native picker.
const source = fs.readFileSync('js/reader/semantic-import-bridge.js', 'utf8');
const owner = source.slice(source.indexOf('let manualFile ='), source.indexOf('function canonicalReaderApp()'));
async function scenario({ change = true, fail = false, clear = false } = {}) {
  const handlers = {};
  let parses = 0, saves = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const file = { name: 'Kafka.epub', type: 'application/epub+zip' };
  const input = { id: 'reader-import-file', files: [file] };
  const button = { disabled: false, getAttribute: () => 'saveReaderImport()' };
  const ctx = vm.createContext({
    document: { addEventListener: (name, fn) => { handlers[name] = fn; }, getElementById: () => input },
    canonicalReaderApp: async () => ({ readerImportFromFile: () => { throw Error('legacy route'); } }),
    handleSemanticEpub: async event => {
      assert.equal(event.target.files[0], file);
      parses++;
      await barrier;
      vm.runInContext(`pendingImport = ${fail ? 'null' : '{}'};`, ctx);
    },
    savePendingSemanticBook: async () => { saves++; },
    setStatus: () => {},
  });
  vm.runInContext('let pendingImport = null;\n' + owner + '\ninstallManualEpubEvents();', ctx);
  let stopped = 0;
  if (change) handlers.change({ target: input, stopImmediatePropagation: () => stopped++ });
  if (clear) input.files = [];
  const event = { target: { closest: () => button }, preventDefault() {}, stopImmediatePropagation: () => stopped++ };
  handlers.click(event);
  handlers.click(event); // Double tap must not duplicate save or parse.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves, 0, 'save must wait for parser');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parses, 1, 'one parse per selection');
  assert.equal(saves, fail ? 0 : 1);
  assert.equal(button.disabled, false);
  assert.ok(stopped >= 2, 'inline legacy save must be intercepted');
}
await scenario();
await scenario({ change: false });
await scenario({ fail: true });
await scenario({ clear: true });
console.log('PASS: normal selection, missed change, parse failure, cleared input, early/double save');

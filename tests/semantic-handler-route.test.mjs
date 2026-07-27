import assert from 'node:assert/strict';

const originalImport = function originalImport() {};
const originalSave = function originalSave() {};
const importStub = function importStub() {};
const saveStub = function saveStub() {};
importStub.__isStub = true;
saveStub.__isStub = true;

globalThis.window = {
  readerImportFromFile: importStub,
  saveReaderImport: saveStub,
  __real_readerImportFromFile: originalImport,
  __real_saveReaderImport: originalSave,
};

const { installSemanticRouteNow } = await import('../js/reader/semantic-import-bridge.js');

assert.equal(installSemanticRouteNow(), true, 'route should install once real handlers exist');

const routedImport = window.readerImportFromFile;
const routedSave = window.saveReaderImport;

assert.equal(typeof routedImport, 'function');
assert.equal(typeof routedSave, 'function');
assert.notEqual(routedImport, originalImport, 'import must be wrapped');
assert.notEqual(routedSave, originalSave, 'save must be wrapped');
assert.equal(routedImport.__semanticStage1, true);
assert.equal(routedSave.__semanticStage1, true);
assert.equal(routedImport.__semanticOriginal, originalImport);
assert.equal(routedSave.__semanticOriginal, originalSave);

// This is the critical production path: index.html stubs call __real_NAME,
// not window[name] directly.
assert.equal(window.__real_readerImportFromFile, routedImport, 'real import route must be replaced');
assert.equal(window.__real_saveReaderImport, routedSave, 'real save route must be replaced');

assert.equal(installSemanticRouteNow(), true, 'install must be idempotent');
assert.equal(window.readerImportFromFile, routedImport, 'idempotent install must not double-wrap import');
assert.equal(window.saveReaderImport, routedSave, 'idempotent install must not double-wrap save');

console.log('semantic handler routing: OK');

import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';

const browser = new Window({ url: 'https://appassets.androidplatform.net/assets/www/index.html' });

globalThis.window = browser;
globalThis.document = browser.document;
globalThis.localStorage = browser.localStorage;
globalThis.DOMParser = browser.DOMParser;
globalThis.Node = browser.Node;
globalThis.Element = browser.Element;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.FileReader = browser.FileReader;
globalThis.File = browser.File;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

browser.document.body.innerHTML = `
  <div id="reader-import-status"></div>
  <textarea id="reader-import-text"></textarea>
  <input id="reader-import-title" value="Nada — adaptation A2">
  <input id="reader-import-author" value="Old author">
  <select id="reader-import-lang">
    <option value="fr">FR</option>
    <option value="es" selected>ES</option>
  </select>
  <select id="reader-import-level"><option value="original" selected>Original</option></select>
`;

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nksAAAAASUVORK5CYII=',
  'base64',
));

const containerXml = `<?xml version="1.0"?>
<container>
  <rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles>
</container>`;

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package>
  <metadata>
    <title>Integration Book</title>
    <creator>Integration Author</creator>
    <language>es</language>
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/pic.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="chapter"/></spine>
</package>`;

const chapter = `<!doctype html>
<html><body>
  <h1>Capítulo de prueba</h1>
  <p>Texto <strong>negrita</strong> y <em>cursiva</em>.</p>
  <figure><img src="images/pic.png" alt="Mapa"><figcaption>Mapa de prueba</figcaption></figure>
</body></html>`;

// Store all files without compression so the test exercises the EPUB reader,
// metadata parser and persistence without depending on a platform inflater.
const epubBytes = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(containerXml),
  'OEBPS/content.opf': strToU8(opf),
  'OEBPS/chapter.xhtml': strToU8(chapter),
  'OEBPS/images/pic.png': png,
}, { level: 0 });

let legacyImportCalls = 0;
let legacySaveCalls = 0;
let openedBookId = '';
let renderCalls = 0;
let closeCalls = 0;
const toasts = [];

function legacyImport() { legacyImportCalls += 1; }
function legacySave() { legacySaveCalls += 1; }

const importStub = (...args) => browser.__real_readerImportFromFile(...args);
const saveStub = (...args) => browser.__real_saveReaderImport(...args);
importStub.__isStub = true;
saveStub.__isStub = true;

browser.readerImportFromFile = importStub;
browser.saveReaderImport = saveStub;
browser.__real_readerImportFromFile = legacyImport;
browser.__real_saveReaderImport = legacySave;
browser.closeReaderImportModal = () => { closeCalls += 1; };
browser.renderReaderScreen = async () => { renderCalls += 1; };
browser.readerOpenBook = async id => { openedBookId = id; };
browser.showToast = text => { toasts.push(String(text)); };

const { installSemanticRouteNow } = await import('../js/reader/semantic-import-bridge.js');
assert.equal(installSemanticRouteNow(), true, 'semantic route must install');

const file = new browser.File([epubBytes], 'integration.epub', { type: 'application/epub+zip' });
await browser.__real_readerImportFromFile({ target: { files: [file] } });

assert.equal(legacyImportCalls, 0, 'EPUB must not go through the legacy importer');
const importStatus = browser.document.getElementById('reader-import-status').textContent;
assert.doesNotMatch(importStatus, /^❌/, `semantic parser failed: ${importStatus}`);
assert.equal(browser.document.getElementById('reader-import-title').value, 'Integration Book', 'EPUB title must replace stale modal title');
assert.equal(browser.document.getElementById('reader-import-author').value, 'Integration Author', 'EPUB author must replace stale modal author');
assert.equal(browser.document.getElementById('reader-import-lang').value, 'es');
assert.match(importStatus, /EPUB проверен: 1 глав · 1 изображений/);
assert.match(browser.document.getElementById('reader-import-text').placeholder, /семантическим импортёром/);

await browser.__real_saveReaderImport();

assert.equal(legacySaveCalls, 0, 'semantic pending import must not go through legacy save');
assert.equal(closeCalls, 1, 'import modal must close once');
assert.equal(renderCalls, 1, 'library must re-render once');
assert.ok(openedBookId, 'saved semantic book must be opened');

const books = JSON.parse(browser.localStorage.getItem('an2_reader_books_v1') || '[]');
assert.equal(books.length, 1);
const book = books[0];
assert.equal(book.id, openedBookId);
assert.equal(book.schemaVersion, 2);
assert.equal(book.source, 'epub-semantic-stage1');
assert.equal(book.title, 'Integration Book');
assert.equal(book.author, 'Integration Author');
assert.equal(book.lang, 'es');
assert.equal(book.chapters.length, 1);
assert.equal(book.epubDiagnostics.images, 1);
assert.ok(book.coverKey, 'cover key must be persisted');

const items = book.chapters[0].paragraphs;
assert.ok(items.some(item => item?.type === 'heading'), 'heading must survive import');
const image = items.find(item => item?.type === 'image');
assert.ok(image?.key, 'image item must contain an IndexedDB key');
assert.equal(image.caption, 'Mapa de prueba');
const runs = items.flatMap(item => item?.runs || []);
assert.ok(runs.some(run => run.marks?.includes('bold')), 'bold formatting must survive import');
assert.ok(runs.some(run => run.marks?.includes('italic')), 'italic formatting must survive import');

const { imgStoreGet } = await import('../js/reader/image-store.js');
const storedImage = await imgStoreGet(image.key);
const storedCover = await imgStoreGet(book.coverKey);
assert.ok(storedImage instanceof Blob, 'chapter image Blob must exist in IndexedDB');
assert.ok(storedCover instanceof Blob, 'cover Blob must exist in IndexedDB');
assert.ok(toasts.some(text => text.includes('семантическом формате')));

console.log('semantic EPUB full integration: OK');

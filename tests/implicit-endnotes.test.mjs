import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';

const browser = new Window({ url: 'https://appassets.androidplatform.net/assets/www/index.html' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  localStorage: browser.localStorage,
  DOMParser: browser.DOMParser,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  FileReader: browser.FileReader,
  File: browser.File,
  indexedDB,
  IDBKeyRange,
});

browser.document.body.innerHTML = '<div id="reader-reading-view"><div id="reader-chapter-text"></div></div>';

const epubBytes = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
  'OEBPS/content.opf': strToU8(`
    <package><metadata><title>Implicit notes</title><creator>Test</creator><language>es</language></metadata>
      <manifest>
        <item id="chapter" href="Text/1__Fantasmas.html" media-type="application/xhtml+xml"/>
        <item id="notes" href="Text/Notas.html" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="chapter"/><itemref idref="notes"/></spine>
    </package>`),
  'OEBPS/Text/1__Fantasmas.html': strToU8(`
    <html><body><h1>Fantasmas</h1>
      <p>Primera referencia<sup><span>1</span></sup> y segunda<sup>2</sup>.</p>
    </body></html>`),
  'OEBPS/Text/Notas.html': strToU8(`
    <html><body>
      <p><span style="font-weight:bold">Capítulo 1: Fantasmas</span></p>
      <p><span>1. Primera nota <em>importante</em>.</span></p>
      <p><span>2. Segunda nota.</span></p>
    </body></html>`),
}, { level: 0 });

const { parseSemanticEpubFile } = await import('../js/reader/semantic-import-stage1.js');
const { contentItemText } = await import('../js/reader/semantic-content.js');
const { renderContentItem } = await import('../js/reader/semantic-content-footnotes.js');
const { installFootnoteUi } = await import('../js/reader/footnote-ui-stage1.js');

const file = new browser.File([epubBytes], 'implicit-notes.epub', { type: 'application/epub+zip' });
const book = await parseSemanticEpubFile(file, { bookId: 'implicit-notes-test' });

assert.equal(book.chapters.length, 1, 'the standalone Notas document must not become a reading chapter');
assert.equal(book.diagnostics.footnotes, 2);
assert.equal(Object.keys(book.footnotes || {}).length, 2);

const item = book.chapters[0].paragraphs.find(row => (row.runs || []).some(run => run?.footnote));
const refs = (item?.runs || []).filter(run => run?.footnote);
assert.deepEqual(refs.map(run => run.footnote.label), ['1', '2']);
assert.equal(contentItemText(item), 'Primera referencia y segunda.', 'implicit note numbers must stay out of TTS and translation text');

const firstNote = book.footnotes[refs[0].footnote.target];
assert.equal((firstNote.items || []).map(contentItemText).join(' '), 'Primera nota importante.');
assert.ok(firstNote.items.flatMap(row => row.runs || []).some(run => run.marks?.includes('italic')));

browser.document.getElementById('reader-chapter-text').innerHTML = renderContentItem(item, 0, { renderLegacy: text => String(text || '') });
installFootnoteUi({ getCurrentBook: () => book });
browser.document.querySelector('.reader-footnote-ref').click();
const layer = browser.document.getElementById('reader-footnote-layer');
assert.ok(layer.classList.contains('open'));
assert.match(layer.querySelector('.reader-footnote-body').textContent, /Primera nota importante/);

console.log('implicit endnotes: OK');

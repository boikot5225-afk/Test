import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'https://appassets.androidplatform.net/assets/www/index.html' });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.Node = browser.Node;
globalThis.HTMLElement = browser.HTMLElement;

browser.document.body.innerHTML = `
  <div id="reader-reading-view">
    <div id="reader-chapter-text"></div>
  </div>
`;

const target = 'OEBPS/notes.xhtml#n1';
const book = {
  footnotes: {
    [target]: {
      id: 'n1',
      items: [
        { type: 'paragraph', runs: [{ text: 'Текст примечания.', marks: [] }] },
        { type: 'paragraph', runs: [{ text: 'Вторая строка.', marks: ['italic'] }] },
      ],
    },
  },
};

let spoken = '';
browser.readerSpeakText = text => { spoken = String(text || ''); };

const { contentItemText } = await import('../js/reader/semantic-content.js');
const { renderContentItem } = await import('../js/reader/semantic-content-footnotes.js');
const { installFootnoteUi } = await import('../js/reader/footnote-ui-stage1.js');

const item = {
  type: 'paragraph',
  runs: [
    { text: 'Фраза со сноской', marks: [] },
    { text: '', marks: [], footnote: { label: '1', target } },
    { text: ' продолжается.', marks: [] },
  ],
};

assert.equal(contentItemText(item), 'Фраза со сноской продолжается.', 'plain text must exclude footnote label');
const html = renderContentItem(item, 0, { renderLegacy: text => text });
assert.match(html, /class="reader-footnote-ref"/);
assert.match(html, /data-reader-footnote-target="OEBPS\/notes\.xhtml#n1"/);
assert.match(html, />1<\/button>/);

browser.document.getElementById('reader-chapter-text').innerHTML = html;
installFootnoteUi({ getCurrentBook: () => book });

browser.document.querySelector('.reader-footnote-ref').click();
const layer = browser.document.getElementById('reader-footnote-layer');
assert.ok(layer.classList.contains('open'), 'reference click must open the footnote sheet');
assert.equal(layer.getAttribute('aria-hidden'), 'false');
assert.match(layer.querySelector('.reader-footnote-title').textContent, /1/);
assert.match(layer.querySelector('.reader-footnote-body').textContent, /Текст примечания/);
assert.match(layer.querySelector('.reader-footnote-body').textContent, /Вторая строка/);

layer.querySelector('.reader-footnote-listen').click();
assert.equal(spoken, 'Текст примечания.\n\nВторая строка.', 'listen button must speak note text only');

layer.querySelector('.reader-footnote-close').click();
assert.equal(layer.classList.contains('open'), false, 'close button must hide the footnote sheet');
assert.equal(layer.getAttribute('aria-hidden'), 'true');

console.log('footnote stage1: OK');

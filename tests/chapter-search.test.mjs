import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'https://appassets.androidplatform.net/assets/www/index.html' });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.Node = browser.Node;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.requestAnimationFrame = callback => callback();

browser.document.body.innerHTML = `
  <div id="reader-reading-view" style="display:flex">
    <div class="rd-top"></div>
    <button id="reader-search-btn"></button>
    <div class="rd-scroll">
      <div id="reader-chapter-text">
        <div class="reader-paragraph active" data-p="0">
          <div class="reader-paragraph-text"><span class="reader-word">Cártel</span> <span class="reader-word">del</span> <span class="reader-word">norte</span>.</div>
        </div>
        <div class="reader-paragraph" data-p="1">
          <div class="reader-paragraph-text">El <span class="reader-word">cartel</span> creció.</div>
        </div>
      </div>
    </div>
  </div>`;

const book = { currentChapter: 0, currentParagraph: 0 };
const selected = [];
browser.readerSelectParagraph = index => {
  book.currentParagraph = Number(index);
  selected.push(Number(index));
};

const {
  chapterSearchDebugState,
  closeChapterSearch,
  installChapterSearch,
  moveChapterSearch,
  openChapterSearch,
  runChapterSearch,
} = await import('../js/reader/chapter-search.js');

installChapterSearch({ getCurrentBook: () => book });
assert.equal(openChapterSearch(), true);
assert.ok(browser.document.getElementById('reader-chapter-search-panel').classList.contains('open'));

assert.equal(runChapterSearch('cartel'), 2, 'search must be case- and accent-insensitive');
assert.equal(browser.document.querySelectorAll('mark.reader-search-hit').length, 2);
assert.equal(chapterSearchDebugState().activeIndex, 0);

assert.equal(moveChapterSearch(1), true);
assert.equal(chapterSearchDebugState().activeIndex, 1);
assert.equal(book.currentParagraph, 1, 'next result must select its paragraph');
assert.deepEqual(selected, [1]);
assert.ok(browser.document.querySelector('mark.reader-search-hit.current'));

assert.equal(runChapterSearch('cartel del'), 1, 'a phrase may span several word elements');
assert.ok(browser.document.querySelectorAll('mark.reader-search-hit').length >= 2, 'all pieces of a cross-element phrase must be highlighted');

assert.equal(runChapterSearch('inexistente'), 0);
assert.match(browser.document.querySelector('.reader-search-count').textContent, /Не найдено/);

closeChapterSearch();
assert.equal(browser.document.querySelectorAll('mark.reader-search-hit').length, 0, 'closing search must restore the original reader DOM');
assert.equal(browser.document.getElementById('reader-chapter-search-panel').classList.contains('open'), false);

console.log('chapter search: OK');

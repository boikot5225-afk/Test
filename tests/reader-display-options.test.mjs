import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'https://appassets.androidplatform.net/assets/www/index.html' });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.localStorage = browser.localStorage;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = callback => callback();

const { createReaderDisplay, normalizeReaderTheme } = await import('../js/reader/display.js');
const { createReaderPagesMode, normalizePageAnimation } = await import('../js/reader/pages-mode.js');

const themes = ['paper', 'ivory', 'sepia', 'vellum', 'sage', 'mist', 'eink', 'ink', 'amoled'];
themes.forEach(theme => assert.equal(normalizeReaderTheme(theme), theme));
assert.equal(normalizeReaderTheme(' SAGE '), 'sage', 'theme names are normalized');
assert.equal(normalizeReaderTheme('parchment'), 'paper', 'legacy parchment setting stays compatible');
assert.equal(normalizeReaderTheme('night'), 'ink', 'legacy night setting stays compatible');
assert.equal(normalizeReaderTheme('unknown'), 'paper', 'invalid themes fall back safely');

document.body.innerHTML = `
  <div id="reader-reading-view"></div>
  <div id="rd-display-back"></div>
  <div id="rd-display-panel">
    ${themes.map(theme => `<button class="rd-dp-theme" data-theme="${theme}"></button>`).join('')}
    <input id="rd-dp-size"><span id="rd-dp-size-val"></span>
    <input id="rd-dp-lh"><span id="rd-dp-lh-val"></span>
  </div>`;

const display = createReaderDisplay({ key: 'reader-display-options-test' });
display.setTheme('sage', document.querySelector('[data-theme="sage"]'));
assert.equal(document.getElementById('reader-reading-view').dataset.rdTheme, 'sage');
assert.equal(display.load().theme, 'sage', 'theme choice is persisted');
display.init();
assert.ok(document.querySelector('[data-theme="sage"]').classList.contains('rd-dp-active'));

const animations = ['flip', 'slide', 'stack', 'fade', 'none'];
animations.forEach(animation => assert.equal(normalizePageAnimation(animation), animation));
assert.equal(normalizePageAnimation('invalid'), 'flip', 'invalid animation falls back safely');

document.body.innerHTML = `
  <div id="reader-reading-view">
    <div class="rd-scroll" style="padding:0">
      <div id="reader-chapter-text">
        <div class="reader-paragraph" data-p="0">First page</div>
        <div class="reader-paragraph" data-p="1">Second page</div>
      </div>
    </div>
  </div>`;

const scroller = document.querySelector('.rd-scroll');
const paragraphs = [...document.querySelectorAll('.reader-paragraph')];
Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
scroller.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 320, width: 320, height: 200 });
paragraphs.forEach((paragraph, index) => {
  paragraph.getBoundingClientRect = () => ({
    top: index * 110, bottom: index * 110 + 100,
    left: 0, right: 320, width: 320, height: 100,
  });
});

let activeParagraph = 0;
const pageEvents = [];
const pagesMode = createReaderPagesMode({
  getChapterText: () => document.getElementById('reader-chapter-text'),
  getScroller: () => scroller,
  getActiveParagraphIndex: () => activeParagraph,
  setActiveParagraphIndex: index => { activeParagraph = index; },
  onPageChange: (index, total) => pageEvents.push({ index, total }),
});

pagesMode.setAnimation('slide');
assert.equal(scroller.dataset.rdPageAnimation, 'slide');
assert.equal(localStorage.getItem('an2_reader_page_animation_v1'), 'slide', 'animation choice is persisted');
assert.equal(pagesMode.setMode('pages'), true);
assert.equal(document.querySelectorAll('.rd-page').length, 2, 'content is split into measured pages');

assert.equal(pagesMode.next(), true);
let pageElements = [...document.querySelectorAll('.rd-page')];
assert.ok(pageElements[0].classList.contains('rd-page-forward'));
assert.ok(pageElements[0].classList.contains('rd-page-out'));
assert.ok(pageElements[1].classList.contains('rd-page-in-active'));
const forwardEnd = new browser.Event('transitionend');
Object.defineProperty(forwardEnd, 'propertyName', { value: 'transform' });
pageElements[0].dispatchEvent(forwardEnd);
assert.equal(activeParagraph, 1);

assert.equal(pagesMode.prev(), true);
pageElements = [...document.querySelectorAll('.rd-page')];
assert.ok(pageElements[1].classList.contains('rd-page-backward'), 'backward turns use the opposite direction');
const backwardEnd = new browser.Event('transitionend');
Object.defineProperty(backwardEnd, 'propertyName', { value: 'transform' });
pageElements[1].dispatchEvent(backwardEnd);
assert.equal(activeParagraph, 0);

pagesMode.setAnimation('none');
assert.equal(pagesMode.next(), true, 'no-animation mode still turns the page');
assert.equal(activeParagraph, 1, 'no-animation mode completes immediately');
assert.ok(pageEvents.some(event => event.total === 2));

console.log('reader display options: OK');

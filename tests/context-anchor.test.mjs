import {
  buildStableContextAnchor,
  contextTextFingerprint,
  normalizeContextText,
} from '../js/reader/context-anchor.js';

function assert(name, condition) {
  if (!condition) throw new Error(name);
  console.log(`✓ ${name}`);
}

const original = buildStableContextAnchor({
  bookId: 'book-7',
  chapterKey: 'Text/chapter-1.xhtml',
  text: '  Il   frappa à la porte. ',
  occurrence: 0,
});
const rerendered = buildStableContextAnchor({
  bookId: 'book-7',
  chapterKey: 'Text/chapter-1.xhtml',
  text: 'Il frappa à la porte.',
  occurrence: 0,
});
const anotherChapter = buildStableContextAnchor({
  bookId: 'book-7',
  chapterKey: 'Text/chapter-2.xhtml',
  text: 'Il frappa à la porte.',
  occurrence: 0,
});
const duplicateParagraph = buildStableContextAnchor({
  bookId: 'book-7',
  chapterKey: 'Text/chapter-1.xhtml',
  text: 'Il frappa à la porte.',
  occurrence: 1,
});

assert('context text normalization ignores layout whitespace', normalizeContextText(' a\n b ') === 'a b');
assert('text fingerprint survives layout whitespace changes', contextTextFingerprint('a  b') === contextTextFingerprint('a\nb'));
assert('same book/chapter/text keeps the same anchor after rerender', original.place === rerendered.place);
assert('same text in another chapter is a different context', original.place !== anotherChapter.place);
assert('duplicate identical paragraphs remain distinct', original.place !== duplicateParagraph.place);
assert('stable anchors are versioned for migration', original.place.startsWith('ctx2:'));

console.log('context anchor: OK');

import assert from 'node:assert/strict';
import { nextSemanticSpeechTarget } from '../js/reader/semantic-tts-target.js';

const book = {
  id: 'b1',
  schemaVersion: 2,
  currentChapter: 0,
  currentParagraph: 0,
  chapters: [
    {
      paragraphs: [
        { type: 'paragraph', runs: [{ text: 'current', marks: [] }] },
        { type: 'image', key: 'b1::img.jpg' },
        { type: 'heading', level: 2, runs: [{ text: 'Next heading', marks: ['bold'] }] },
      ],
    },
    {
      paragraphs: [
        { type: 'paragraph', runs: [{ text: 'Following chapter', marks: [] }] },
      ],
    },
  ],
};

assert.deepEqual(nextSemanticSpeechTarget(book), {
  chapterIndex: 0,
  paragraphIndex: 2,
  text: 'Next heading',
}, 'image should be skipped while semantic heading remains readable');

book.currentParagraph = 2;
assert.deepEqual(nextSemanticSpeechTarget(book), {
  chapterIndex: 1,
  paragraphIndex: 0,
  text: 'Following chapter',
}, 'prefetch should cross a chapter boundary');

assert.equal(nextSemanticSpeechTarget({ ...book, schemaVersion: 1 }), null, 'legacy books use their existing prefetch path');

console.log('semantic TTS target checks passed');

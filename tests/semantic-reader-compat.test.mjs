globalThis.window = { speechSynthesis: { cancel() {} } };

const {
  contentItemText,
  chapterContentText,
  renderContentItem,
} = await import('../js/reader/semantic-content.js');
const { createReaderNavigation } = await import('../js/reader/navigation.js');
const { createReaderAudio } = await import('../js/reader/audio.js');

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`✓ ${name}`);
}

const items = [
  { type: 'image', key: 'book::cover.jpg', alt: 'Обложка' },
  { type: 'heading', level: 1, runs: [{ text: 'Capítulo ', marks: [] }, { text: 'uno', marks: ['italic'] }] },
  { type: 'paragraph', runs: [{ text: 'Texto ', marks: [] }, { text: 'fuerte', marks: ['bold'] }] },
  { type: 'image', key: 'book::photo.jpg', caption: 'Foto' },
  { type: 'quote', runs: [{ text: 'Cita', marks: ['italic'] }] },
];

const book = {
  currentChapter: 0,
  currentParagraph: 0,
  chapters: [{ id: 'ch_0', paragraphs: items }],
};
let renders = 0;
const navigation = createReaderNavigation({
  getBook: () => book,
  render: () => { renders += 1; },
  closeParagraphTime() {},
  scrollActiveParagraph() {},
  showToast() {},
});

assert('semantic item → plain text', contentItemText(items[2]) === 'Texto fuerte');
assert('chapter text skips images', chapterContentText(items) === 'Capítulo uno Texto fuerte Cita');
assert('chapter TTS sentinel returns text', navigation.currentParagraphText('__chapter_semantic__') === 'Capítulo uno Texto fuerte Cita');

navigation.selectParagraph(0);
assert('selecting image chooses next readable item', book.currentParagraph === 1, String(book.currentParagraph));
navigation.nextParagraph();
assert('next opens semantic paragraph', book.currentParagraph === 2, String(book.currentParagraph));
navigation.nextParagraph();
assert('next skips image', book.currentParagraph === 4, String(book.currentParagraph));
navigation.previousParagraph();
assert('previous skips image', book.currentParagraph === 2, String(book.currentParagraph));

const paragraphHtml = renderContentItem(items[2], 2, { renderLegacy: text => text });
const imageHtml = renderContentItem(items[3], 3, { renderLegacy: text => text });
assert('bold mark renders', paragraphHtml.includes('<strong>fuerte</strong>'));
assert('image caption renders', imageHtml.includes('<figcaption>Foto</figcaption>'));

const dialogue = {
  type: 'paragraph',
  runs: [{ text: '— Salut.\n— Salut.\n— J’ai un rendez-vous…', marks: [] }],
};
const dialogueHtml = renderContentItem(dialogue, 5, { renderLegacy: text => text });
assert(
  'EPUB dialogue line breaks render as br',
  dialogueHtml.includes('— Salut.<br>— Salut.<br>— J’ai un rendez-vous…'),
  dialogueHtml,
);

const markedDialogue = {
  type: 'paragraph',
  runs: [{ text: '— Première ligne\n— Deuxième ligne', marks: ['italic'] }],
};
const markedDialogueHtml = renderContentItem(markedDialogue, 6, { renderLegacy: text => text });
assert(
  'formatting survives across dialogue lines',
  markedDialogueHtml.includes('<em>— Première ligne</em><br><em>— Deuxième ligne</em>'),
  markedDialogueHtml,
);

const spoken = [];
const audio = createReaderAudio({
  speak: async text => { spoken.push(text); return true; },
  stopSpeak() {},
  showToast() {},
  getParagraphText: index => navigation.currentParagraphText(index),
  getLang: () => 'es',
  onActiveChange() {},
});
book.currentParagraph = 2;
await audio.speakParagraph(null);
assert('paragraph TTS receives plain text', spoken.at(-1) === 'Texto fuerte', spoken.at(-1));
await audio.speakChapter();
assert('chapter TTS receives plain text', spoken.at(-1) === 'Capítulo uno Texto fuerte Cita', spoken.at(-1));
assert('navigation rendered after moves', renders >= 4, String(renders));

console.log('semantic reader compatibility: OK');

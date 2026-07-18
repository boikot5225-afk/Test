globalThis.window = { speechSynthesis: { cancel() {} } };

const {
  contentItemText,
  chapterContentText,
  normalizeSemanticBookLineItems,
  normalizeSemanticBookTextChunks,
  normalizeSemanticBookTranslations,
  renderContentItem,
  splitSemanticItemChunks,
  translationValueText,
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
  'old EPUB dialogue line breaks still render as br',
  dialogueHtml.includes('— Salut.<br>— Salut.<br>— J’ai un rendez-vous…'),
  dialogueHtml,
);

const markedDialogue = {
  type: 'paragraph',
  runs: [{ text: '— Première ligne\n— Deuxième ligne', marks: ['italic'] }],
};
const markedDialogueHtml = renderContentItem(markedDialogue, 6, { renderLegacy: text => text });
assert(
  'formatting survives across old dialogue lines',
  markedDialogueHtml.includes('<em>— Première ligne</em><br><em>— Deuxième ligne</em>'),
  markedDialogueHtml,
);

const longProse = {
  type: 'paragraph',
  runs: [
    { text: 'La policía encontró una mina de plata con cincuenta y seis personas ya muertas. ', marks: [] },
    { text: 'Algunas fueron arrojadas todavía con vida; otras habían sido secuestradas durante la noche. ', marks: ['italic'] },
    { text: 'Las matanzas en México son comparables a bárbaros crímenes de guerra.', marks: [] },
  ],
};
const proseChunks = splitSemanticItemChunks(longProse, { maxChars: 120, minChars: 55 });
assert('oversized prose becomes several semantic blocks', proseChunks.length >= 2, String(proseChunks.length));
assert(
  'prose chunks stay under configured size',
  proseChunks.every(item => contentItemText(item).length <= 120),
  proseChunks.map(item => contentItemText(item).length).join(','),
);
assert(
  'prose text survives chunking',
  proseChunks.map(contentItemText).join(' ').replace(/\s+/g, ' ').trim() === contentItemText(longProse).replace(/\s+/g, ' ').trim(),
);
assert('inline formatting survives prose chunking', proseChunks.some(item => item.runs.some(run => run.marks?.includes('italic'))));

const existingBook = {
  schemaVersion: 2,
  currentChapter: 0,
  currentParagraph: 2,
  readerTranslations: {
    'ch_0:1': { translation: { ru: 'Старый перевод целого диалога' } },
    'ch_0:2': '[object Object]',
  },
  readerAnalyses: { 'ch_0:1': { summary: 'Старый разбор' } },
  chapters: [{
    id: 'ch_0',
    paragraphs: [
      { type: 'heading', level: 1, runs: [{ text: 'Chapitre 1', marks: [] }] },
      {
        type: 'paragraph',
        runs: [
          { text: '— Première réplique\n— Deuxième ', marks: [] },
          { text: 'réplique', marks: ['italic'] },
          { text: '\n— Troisième réplique', marks: [] },
        ],
      },
      { type: 'paragraph', runs: [{ text: 'Narration après le dialogue.', marks: [] }] },
    ],
  }],
};
const lineItemsChanged = normalizeSemanticBookLineItems(existingBook);
assert('existing semantic book dialogue migrates', lineItemsChanged === true);
assert(
  'dialogue becomes three independent paragraphs',
  existingBook.chapters[0].paragraphs.map(contentItemText).join('|') ===
    'Chapitre 1|— Première réplique|— Deuxième réplique|— Troisième réplique|Narration après le dialogue.',
  existingBook.chapters[0].paragraphs.map(contentItemText).join('|'),
);
assert('italic formatting survives paragraph split', existingBook.chapters[0].paragraphs[2].runs.some(run => run.marks?.includes('italic')));
assert('reading position follows content after split', existingBook.currentParagraph === 4, String(existingBook.currentParagraph));
assert('dialogue migration is one-shot', normalizeSemanticBookLineItems(existingBook) === false);

assert(
  'stale translations are cleared after paragraph reindex',
  normalizeSemanticBookTranslations(existingBook, { reindexed: lineItemsChanged }) === true,
);
assert('old translation keys removed', Object.keys(existingBook.readerTranslations).length === 0);
assert('old analysis keys removed', Object.keys(existingBook.readerAnalyses).length === 0);
assert(
  'nested translation object extracts Russian string',
  translationValueText({ data: { translation: { ru: 'Нормальный перевод' } } }) === 'Нормальный перевод',
);
assert('literal object placeholder is rejected', translationValueText('[object Object]') === '');
assert('localized bracketed object placeholder is rejected', translationValueText('[объект Объект]') === '');
assert('localized bare object placeholder is rejected', translationValueText('Объект Объект') === '');
existingBook.readerTranslations['ch_0:4'] = { data: { translatedText: 'Новый перевод повествования' } };
assert('new object translation is normalized', normalizeSemanticBookTranslations(existingBook) === true);
assert(
  'normalized translation is stored as text',
  existingBook.readerTranslations['ch_0:4'] === 'Новый перевод повествования',
  String(existingBook.readerTranslations['ch_0:4']),
);

const chunkBook = {
  schemaVersion: 2,
  currentChapter: 0,
  currentParagraph: 1,
  _semanticLineItemsV1: true,
  _semanticTranslationKeysV3: true,
  readerTranslations: { 'ch_0:1': 'Перевод старого длинного абзаца' },
  readerAnalyses: { 'ch_0:1': { summary: 'Разбор старого длинного абзаца' } },
  chapters: [{
    id: 'ch_0',
    paragraphs: [
      { type: 'heading', level: 1, runs: [{ text: 'Capítulo largo', marks: [] }] },
      longProse,
    ],
  }],
};
const chunksChanged = normalizeSemanticBookTextChunks(chunkBook, { maxChars: 120, minChars: 55 });
assert('existing oversized paragraph migrates', chunksChanged === true);
assert('reading position follows first new prose chunk', chunkBook.currentParagraph === 1, String(chunkBook.currentParagraph));
assert('chunk migration is one-shot', normalizeSemanticBookTextChunks(chunkBook, { maxChars: 120, minChars: 55 }) === false);
normalizeSemanticBookTranslations(chunkBook, { reindexed: chunksChanged });
assert('stale translation is cleared after prose chunking', Object.keys(chunkBook.readerTranslations).length === 0);
assert('stale analysis is cleared after prose chunking', Object.keys(chunkBook.readerAnalyses).length === 0);

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

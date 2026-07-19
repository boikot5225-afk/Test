import { Window } from 'happy-dom';

const window = new Window({ url: 'https://reader.test/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.CustomEvent = window.CustomEvent;

const {
  buildWordCandidates,
  mergeLemmaMetadata,
} = await import('../js/reader/word-candidates.js');
const { createReaderWordState } = await import('../js/reader/word-state.js');

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`✓ ${name}`);
}

const now = Date.parse('2026-07-19T12:00:00.000Z');
const recentA = '2026-07-18T12:00:00.000Z';
const recentB = '2026-07-19T10:00:00.000Z';
const old = '2026-05-01T12:00:00.000Z';

const state = {
  'fr:frappa': {
    word: 'frappa', lang: 'fr', lemma: 'frapper', pos: 'verb', clicked: 2,
    clickContexts: {
      'book:a:1': { at: recentA, text: 'Le vendeur le frappa.', form: 'frappa' },
    },
  },
  'fr:frappait': {
    word: 'frappait', lang: 'fr', linkedLemma: 'frapper', pos: 'verb', clicked: 2,
    clickContexts: {
      'book:a:2': { at: recentB, text: 'Il frappait à la porte.', form: 'frappait' },
      'book:a:1': { at: recentB, text: 'Duplicate place from another form.', form: 'frappait' },
    },
  },
  'fr:geneviève': {
    word: 'geneviève', lang: 'fr', lemma: 'geneviève', pos: 'proper_noun', clicked: 3,
    clickContexts: {
      'book:a:3': { at: recentA, text: 'Geneviève entra.' },
      'book:a:4': { at: recentB, text: 'Geneviève répondit.' },
    },
  },
  'fr:ancien': {
    word: 'ancien', lang: 'fr', clicked: 5,
    clickContexts: {
      'book:a:5': { at: old, text: 'Ancien contexte.' },
      'book:a:6': { at: old, text: 'Autre ancien contexte.' },
    },
  },
  'fr:connu': {
    word: 'connu', lang: 'fr', known: true, clicked: 4,
    clickContexts: {
      'book:a:7': { at: recentA, text: 'Connu ici.' },
      'book:a:8': { at: recentB, text: 'Connu là.' },
    },
  },
};

const candidates = buildWordCandidates(state, { lang: 'fr', now, days: 30, minContexts: 2 });
assert('inflected forms group under lemma', candidates.length === 1 && candidates[0].lemma === 'frapper', JSON.stringify(candidates));
assert('same paragraph counts once across forms', candidates[0].contextCount === 2, String(candidates[0].contextCount));
assert('variants retained', candidates[0].variants.includes('frappa') && candidates[0].variants.includes('frappait'));
assert('proper names excluded', !candidates.some(item => item.lemma === 'geneviève'));
assert('old contexts excluded', !candidates.some(item => item.lemma === 'ancien'));
assert('known words excluded', !candidates.some(item => item.lemma === 'connu'));

const lemmaStore = {
  'fr:eut': {
    word: 'eut', lang: 'fr', clicked: 2, saved: false, known: false, status: 'looked',
    clickContexts: {
      'book:b:1': { at: recentA, text: 'Il eut peur.', form: 'eut' },
      'book:b:2': { at: recentB, text: 'Elle eut raison.', form: 'eut' },
    },
  },
};
assert('lemma metadata merges into canonical entry', mergeLemmaMetadata(lemmaStore, { surface: 'eut', lemma: 'avoir', pos: 'verb', lang: 'fr' }));
assert('canonical lemma entry created', !!lemmaStore['fr:avoir']);
assert('surface links to lemma', lemmaStore['fr:eut'].linkedLemma === 'avoir');
assert('click contexts copied to lemma', Object.keys(lemmaStore['fr:avoir'].clickContexts).length === 2);

let cache = null;
const storeKey = 'test-word-state';
const wordState = createReaderWordState({
  getCache: () => cache,
  setCache: value => { cache = value; },
  storageKey: () => storeKey,
  canonicalLang: lang => lang || 'fr',
  currentLang: () => 'fr',
  normalizeWord: word => String(word || '').toLowerCase(),
  normalizeImportKey: word => word,
  isCommonWord: () => false,
  seenAfter: 2,
  fadeAfter: 5,
  familiarAfter: 4,
  getBookLang: () => 'fr',
  tokenizeParagraph: text => String(text || '').split(/\s+/),
  findVerbByForm: () => null,
  idbPut: async () => {},
  idbGet: async () => null,
});

document.body.innerHTML = `
  <div id="reader-book-title">Nada</div>
  <div id="reader-chapter-title">Chapitre 1</div>
  <div id="reader-chapter-text">
    <div class="reader-paragraph active" data-p="4">Il frappa le vendeur.</div>
  </div>`;

assert('first tap in paragraph counts', wordState.markClicked('frappa', 'fr') === true);
assert('repeat tap in same paragraph does not count', wordState.markClicked('frappa', 'fr') === false);
let clicked = wordState.get('frappa', 'fr');
assert('same paragraph has one click context', clicked.clicked === 1 && Object.keys(clicked.clickContexts).length === 1);

document.querySelector('.reader-paragraph').dataset.p = '5';
document.querySelector('.reader-paragraph').textContent = 'Puis il frappa encore.';
assert('tap in another paragraph counts', wordState.markClicked('frappa', 'fr') === true);
clicked = wordState.get('frappa', 'fr');
assert('two paragraphs produce two contexts', clicked.clicked === 2 && Object.keys(clicked.clickContexts).length === 2);

console.log('word candidates: OK');

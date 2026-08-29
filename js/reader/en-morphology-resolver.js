// toc101 — guarded English morphology resolver.
//
// The bundled Migaku lemma table stays authoritative. This layer only fills
// gaps when a surface form has exactly one plausible base lemma that already
// exists in Reader's 36,566-word English frequency list. It never owns layout.
// The rules were checked against Migaku's en.sqlite morphology database; the
// 57 MB source database is intentionally not shipped in the APK.

const VERSION = 1;
let timer = null;
let observer = null;
let observedRoot = null;
let running = false;

const SAFE_IRREGULAR = Object.freeze({
  outgrown:'outgrow', outgrew:'outgrow',
  rewritten:'rewrite', overwrote:'overwrite', overwritten:'overwrite',
  underwrote:'underwrite', underwritten:'underwrite',
  misunderstood:'misunderstand',
  withstood:'withstand', withdrawn:'withdraw', withdrew:'withdraw',
  sought:'seek', brought:'bring', bought:'buy', caught:'catch',
  taught:'teach', thought:'think', fought:'fight',
  slept:'sleep', wept:'weep', swept:'sweep', kept:'keep',
  knelt:'kneel', leant:'lean', learnt:'learn', spelt:'spell',
  smelt:'smell', dreamt:'dream', dealt:'deal', meant:'mean',
  paid:'pay', laid:'lay', fled:'flee', fed:'feed', led:'lead',
  dug:'dig', hung:'hang', stuck:'stick', struck:'strike',
  spun:'spin', stung:'sting', swung:'swing', wrung:'wring',
  arose:'arise', arisen:'arise', awoke:'awake', awoken:'awake',
  bore:'bear', borne:'bear', born:'bear',
  chose:'choose', chosen:'choose', froze:'freeze', frozen:'freeze',
  hid:'hide', hidden:'hide', rode:'ride', ridden:'ride',
  shook:'shake', shaken:'shake', spoke:'speak', spoken:'speak',
  stole:'steal', stolen:'steal', tore:'tear', torn:'tear',
  wore:'wear', worn:'wear', wrote:'write', written:'write',
  bit:'bite', bitten:'bite', broke:'break', broken:'break',
  drove:'drive', driven:'drive', ate:'eat', eaten:'eat',
  fell:'fall', fallen:'fall', gave:'give', given:'give',
  grew:'grow', grown:'grow', knew:'know', known:'know',
  saw:'see', seen:'see', took:'take', taken:'take',
  threw:'throw', thrown:'throw', forgot:'forget', forgotten:'forget',
  began:'begin', begun:'begin', drank:'drink', drunk:'drink',
  rang:'ring', rung:'ring', sang:'sing', sung:'sing',
  sank:'sink', sunk:'sink', swam:'swim', swum:'swim',
  blew:'blow', blown:'blow', flew:'fly', flown:'fly',
  drew:'draw', drawn:'draw',
  children:'child', women:'woman', men:'man', mice:'mouse', geese:'goose',
  oxen:'ox', teeth:'tooth'
});

// Contractions whose lexical head is unambiguous. Ambiguous forms such as
// he's / she'd / I'd are deliberately not guessed.
const SAFE_CONTRACTIONS = Object.freeze({
  "can't":'can', "cannot":'can',
  "couldn't":'could', "wouldn't":'would', "shouldn't":'should',
  "mustn't":'must', "mightn't":'might', "needn't":'need',
  "don't":'do', "doesn't":'do', "didn't":'do',
  "isn't":'be', "aren't":'be', "wasn't":'be', "weren't":'be',
  "haven't":'have', "hasn't":'have', "hadn't":'have',
  "won't":'will'
});

function normalize(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('en-US');
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).trim().toLowerCase();
  return raw === 'english' || raw === 'en' || raw.startsWith('en-') ? 'en' : raw;
}

function push(set, value) {
  const clean = normalize(value);
  if (clean && clean.length >= 2) set.add(clean);
}

function regularCandidates(surface) {
  const raw = normalize(surface);
  const out = new Set();
  if (!/^[a-z][a-z'-]*$/.test(raw)) return out;

  // Possessive forms.
  if (raw.endsWith("'s") && raw.length > 3) push(out, raw.slice(0, -2));
  if (raw.endsWith("s'") && raw.length > 3) push(out, raw.slice(0, -1));

  // Plurals / 3rd-person singular.
  if (raw.endsWith('ies') && raw.length > 4) push(out, raw.slice(0, -3) + 'y');
  if (raw.endsWith('ves') && raw.length > 4) {
    push(out, raw.slice(0, -3) + 'f');
    push(out, raw.slice(0, -3) + 'fe');
  }
  if (raw.endsWith('es') && raw.length > 4) {
    push(out, raw.slice(0, -2));
    push(out, raw.slice(0, -1));
  }
  if (raw.endsWith('s') && !raw.endsWith('ss') && raw.length > 3) push(out, raw.slice(0, -1));

  // Past / participle.
  if (raw.endsWith('ied') && raw.length > 4) push(out, raw.slice(0, -3) + 'y');
  if (raw.endsWith('ed') && raw.length > 4) {
    const stem = raw.slice(0, -2);
    push(out, stem);
    push(out, stem + 'e');
    if (/(.)\1$/.test(stem)) push(out, stem.slice(0, -1));
  }

  // -ing forms.
  if (raw.endsWith('ying') && raw.length > 5) push(out, raw.slice(0, -4) + 'ie');
  if (raw.endsWith('ing') && raw.length > 5) {
    const stem = raw.slice(0, -3);
    push(out, stem);
    push(out, stem + 'e');
    if (/(.)\1$/.test(stem)) push(out, stem.slice(0, -1));
  }

  // Comparatives / superlatives.
  for (const suffix of ['est', 'er']) {
    if (!raw.endsWith(suffix) || raw.length <= suffix.length + 2) continue;
    const stem = raw.slice(0, -suffix.length);
    push(out, stem);
    push(out, stem + 'e');
    if (stem.endsWith('i')) push(out, stem.slice(0, -1) + 'y');
    if (/(.)\1$/.test(stem)) push(out, stem.slice(0, -1));
  }
  return out;
}

function rankedLemma(data, surface) {
  const raw = normalize(surface);
  if (!raw || !data?.rankFold) return '';

  const fixed = SAFE_CONTRACTIONS[raw] || SAFE_IRREGULAR[raw] || '';
  if (fixed) {
    const hit = data.rankFold.get(normalize(fixed));
    return hit?.word || '';
  }

  const hits = new Map();
  for (const candidate of regularCandidates(raw)) {
    const hit = data.rankFold.get(candidate);
    if (hit?.word) hits.set(normalize(hit.word), hit.word);
  }
  // This is the safety gate: if suffix stripping points to two real Reader
  // lemmas, do not choose. The existing curated table / dictionary keeps control.
  return hits.size === 1 ? [...hits.values()][0] : '';
}

function augmentOne(data, surface) {
  const raw = normalize(surface);
  if (!raw || !data?.lemma || data.lemma.has(raw)) return false;
  const lemma = rankedLemma(data, raw);
  if (!lemma || normalize(lemma) === raw) return false;
  data.lemma.set(raw, lemma);
  return true;
}

function visibleEnglishSurfaces() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const out = new Set();
  for (const el of root.querySelectorAll('.reader-word[data-word]')) {
    const word = String(el.dataset.word || el.textContent || '').trim();
    if (/[A-Za-z]/.test(word)) out.add(word);
  }
  return [...out];
}

async function augmentVisibleMorphology() {
  if (running || currentLang() !== 'en') return 0;
  running = true;
  try {
    const loader = globalThis.readerLoadEnglishVocabularyData;
    if (typeof loader !== 'function') return 0;
    const data = await loader();
    let changed = 0;
    for (const surface of visibleEnglishSurfaces()) {
      if (augmentOne(data, surface)) changed += 1;
    }
    if (changed) {
      try { await globalThis.readerApplyEnglishVocabularyEstimate?.(); } catch {}
      try { window.dispatchEvent(new CustomEvent('reader:en-morphology-augmented', { detail:{ changed } })); } catch {}
    }
    return changed;
  } finally {
    running = false;
  }
}

function schedule(delay = 40) {
  clearTimeout(timer);
  timer = setTimeout(() => { void augmentVisibleMorphology(); }, Math.max(0, Number(delay) || 0));
}

function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot && typeof MutationObserver === 'function') {
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(records => {
      if (records.some(record => record.type === 'childList' && record.addedNodes?.length)) schedule(50);
    });
    observer.observe(root, { childList:true, subtree:true });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerEnMorphologyResolverV1) {
  window.__readerEnMorphologyResolverV1 = VERSION;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();
  window.addEventListener('pageshow', bind);
  window.addEventListener('reader:en-vocab-ready', () => schedule(0));
}

export { normalize, regularCandidates, rankedLemma, augmentOne, augmentVisibleMorphology };

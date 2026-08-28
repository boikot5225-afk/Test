import { prefetchSpeech } from '../tts.js?v=68.43-zh-tts-cache-bust';
import { nextSemanticSpeechTarget } from './semantic-tts-target.js?v=1';

let installed = false;
let lastPrefetchKey = '';
let readerModulePromise = null;

function loadReaderModule() {
  if (!readerModulePromise) readerModulePromise = import('../reader-app.js?v=77.32');
  return readerModulePromise;
}

async function prefetchNextSemanticParagraph() {
  const reader = await loadReaderModule();
  const book = reader.readerCurrentBook?.();
  const target = nextSemanticSpeechTarget(book);
  if (!book || !target?.text) return;

  const key = `${book.id || ''}:${target.chapterIndex}:${target.paragraphIndex}:${target.text.length}`;
  if (key === lastPrefetchKey) return;
  lastPrefetchKey = key;

  const lang = reader.readerBookLang?.(book) || book.lang || book.sourceLang || 'fr';
  await Promise.resolve(prefetchSpeech(target.text, { lang })).catch(() => {});
}

export function installSemanticTtsPrefetch() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('an2-tts-state', event => {
    // Wait until the current audio is already available and playing. Starting a
    // second cloud request during the current paragraph's loading phase can make
    // slow mobile connections compete with themselves.
    if (event?.detail !== 'playing') return;
    setTimeout(() => { prefetchNextSemanticParagraph().catch(() => {}); }, 80);
  });
}

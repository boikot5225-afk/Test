import { contentItemText } from './semantic-content.js?v=1';

export function nextSemanticSpeechTarget(book) {
  if (!book || Number(book.schemaVersion || 0) < 2) return null;
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (!chapters.length) return null;

  const startChapter = Math.max(0, Math.min(Number(book.currentChapter) || 0, chapters.length - 1));
  const startParagraph = Math.max(0, Number(book.currentParagraph) || 0);

  for (let chapterIndex = startChapter; chapterIndex < chapters.length; chapterIndex += 1) {
    const items = chapters[chapterIndex]?.paragraphs || [];
    const from = chapterIndex === startChapter ? startParagraph + 1 : 0;
    for (let paragraphIndex = from; paragraphIndex < items.length; paragraphIndex += 1) {
      const text = contentItemText(items[paragraphIndex]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      return {
        chapterIndex,
        paragraphIndex,
        text: text.slice(0, 900),
      };
    }
  }

  return null;
}

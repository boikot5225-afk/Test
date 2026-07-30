// Pure parsers for reader imports.
// DOM, files, EPUB and library mutations remain in app.js.
// Kept intentionally behavior-preserving during the split.

export function splitTextToChapters(rawText, fallbackTitle = 'Текст', chunkLongParagraph) {
  const clean = String(rawText || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!clean) return [];

  const lines = clean.split('\n');
  // Japanese and Chinese books head their chapters differently — 第三章, or a
  // bare kanji numeral fenced by ideographic spaces (　一　...). Without these a
  // whole novel arrives as one chapter, which is both unnavigable and slow: the
  // reader builds every paragraph of the open chapter at once.
  const headingRe = /^\s*((chapitre|chapter|глава)\s+[\wivxlcdm\d-]+|[ivxlcdm]{1,8}\.|[0-9]{1,3}\.|第[〇零一二三四五六七八九十百千万0-9０-９]{1,6}[章話回節部篇編]|[　\s]*[〇一二三四五六七八九十]{1,4}[　\s]+\S)\s*[:.\-—]?\s*(.*)$/i;
  const chunks = [];
  let current = { title: fallbackTitle, lines: [] };
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = headingRe.test(trimmed) && current.lines.join('\n').trim().length > 500;
    if (isHeading) {
      chunks.push(current);
      current = { title: trimmed, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  chunks.push(current);

  return chunks.map((chapter, index) => {
    let paragraphs = chapter.lines.join('\n')
      .split(/\n\s*\n+/)
      .map(item => item.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .flatMap(item => chunkLongParagraph(item, 380));
    if (paragraphs.length <= 1 && chapter.lines.join('\n').length > 1200) {
      paragraphs = chunkLongParagraph(chapter.lines.join(' ').replace(/\s+/g, ' '), 380);
    }
    return { id: 'ch_' + index, title: chapter.title || `Глава ${index + 1}`, paragraphs };
  }).filter(chapter => chapter.paragraphs.length)
    .flatMap(splitOversizedChapter)
    .map((chapter, index) => ({ ...chapter, id: 'ch_' + index }));
}

// A book whose headings this file cannot recognise still must not become one
// chapter of thousands of paragraphs: the reader renders a whole chapter into
// the DOM at once, so that is a page the phone cannot lay out. Cut anything
// oversized into readable parts, keeping the original title.
const MAX_CHAPTER_PARAGRAPHS = 300;

function splitOversizedChapter(chapter) {
  const paragraphs = chapter.paragraphs || [];
  if (paragraphs.length <= MAX_CHAPTER_PARAGRAPHS) return [chapter];
  const parts = [];
  for (let start = 0; start < paragraphs.length; start += MAX_CHAPTER_PARAGRAPHS) {
    const number = parts.length + 1;
    parts.push({
      ...chapter,
      title: `${chapter.title} · часть ${number}`,
      paragraphs: paragraphs.slice(start, start + MAX_CHAPTER_PARAGRAPHS),
    });
  }
  return parts;
}

export function splitSongToChapters(rawText, fallbackTitle = 'Песня') {
  const clean = String(rawText || '').replace(/\r/g, '').trim();
  if (!clean) return [];

  const sectionRe = /^\[(.+?)\]\s*$/;
  const lines = clean.split('\n');
  const sections = [];
  let current = { label: fallbackTitle, type: 'verse', lines: [] };

  for (const line of lines) {
    const match = line.trim().match(sectionRe);
    if (match) {
      if (current.lines.some(item => item.trim())) sections.push(current);
      const label = match[1].trim();
      const lower = label.toLowerCase();
      let type = 'verse';
      if (/припев|chorus|ref|refrain/.test(lower)) type = 'chorus';
      else if (/bridge|бридж/.test(lower)) type = 'bridge';
      else if (/outro|аутро/.test(lower)) type = 'outro';
      else if (/intro|интро/.test(lower)) type = 'intro';
      current = { label, type, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some(item => item.trim())) sections.push(current);

  return sections.map((section, index) => ({
    id: 'sec_' + index,
    title: section.label,
    songSection: true,
    sectionType: section.type,
    paragraphs: section.lines.map(line => line.trim()).filter(Boolean),
  })).filter(chapter => chapter.paragraphs.length);
}

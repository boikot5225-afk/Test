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
  const headingRe = /^\s*((chapitre|chapter|глава)\s+[\wivxlcdm\d-]+|[ivxlcdm]{1,8}\.|[0-9]{1,3}\.)\s*[:.\-—]?\s*(.*)$/i;
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
  }).filter(chapter => chapter.paragraphs.length);
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

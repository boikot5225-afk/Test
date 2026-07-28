function normalizeAnchorPart(value, fallback = 'unknown') {
  const clean = String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

export function normalizeContextText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contextTextFingerprint(value) {
  const text = normalizeContextText(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildStableContextAnchor({
  bookId,
  chapterKey,
  text,
  occurrence = 0,
} = {}) {
  const fingerprint = contextTextFingerprint(text);
  const safeBook = encodeURIComponent(normalizeAnchorPart(bookId, 'book'));
  const safeChapter = encodeURIComponent(normalizeAnchorPart(chapterKey, 'chapter'));
  const safeOccurrence = Math.max(0, Number(occurrence) || 0);
  const elementPath = `text:${fingerprint}:${safeOccurrence}`;
  return {
    place: `ctx2:${safeBook}:${safeChapter}:${elementPath}`,
    elementPath,
    textFingerprint: fingerprint,
    textOccurrence: safeOccurrence,
  };
}

export function paragraphTextOccurrence(root, paragraph, text) {
  if (!root || !paragraph) return { occurrence: 0, count: 1 };
  const normalized = normalizeContextText(text);
  let occurrence = 0;
  let count = 0;
  for (const item of root.querySelectorAll?.('.reader-paragraph') || []) {
    const itemText = normalizeContextText(item.querySelector?.('.reader-paragraph-text')?.textContent || item.textContent || '');
    if (itemText !== normalized) continue;
    if (item === paragraph) occurrence = count;
    count += 1;
  }
  return { occurrence, count: Math.max(1, count) };
}

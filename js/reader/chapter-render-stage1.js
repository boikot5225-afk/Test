import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-next.js?v=15-zh-context-inline';
import {
  contentItemText,
  firstReadableContentIndex,
  isImageContentItem,
  renderContentItem,
} from './semantic-content-footnotes.js?v=3';
import { installSemanticImportBridge } from './semantic-import-bridge.js?v=5';
import { installSemanticLibraryCovers } from './library-cover-stage1.js?v=1';
import { installSemanticTtsPrefetch } from './semantic-tts-prefetch-stage1.js?v=1';
import { installFootnoteUi } from './footnote-ui-stage1.js?v=1';
import {
  installChapterSearch,
  refreshChapterSearchAfterRender,
} from './chapter-search.js?v=1';

installSemanticImportBridge();
installSemanticLibraryCovers();
installSemanticTtsPrefetch();

const STYLE_ID = 'reader-stage1-format-style';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function ensureReaderStage1Styles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Stage 1: one final authority for book spacing and EPUB images. */
    #reader-reading-view #reader-chapter-text .reader-paragraph {
      margin: 0 0 .9em !important;
    }
    #reader-reading-view #reader-chapter-text .reader-paragraph.active {
      margin: 0 0 .9em !important;
    }
    #reader-reading-view #reader-chapter-text .reader-paragraph-text {
      overflow-wrap: anywhere;
    }
    #reader-reading-view #reader-chapter-text .reader-paragraph.reader-semantic-layout,
    #reader-reading-view #reader-chapter-text .reader-paragraph.reader-semantic-layout.active {
      margin-top: 0 !important;
      margin-bottom: 0 !important;
    }
    #reader-reading-view #reader-chapter-text .reader-figure {
      display: block;
      max-width: 100%;
      margin: 1.15em auto;
      text-align: center;
    }
    #reader-reading-view #reader-chapter-text .epub-img {
      display: block !important;
      width: auto !important;
      max-width: 100% !important;
      height: auto !important;
      max-height: min(78dvh, 900px) !important;
      object-fit: contain !important;
      margin: 0 auto !important;
      border-radius: 8px;
      background: color-mix(in srgb, var(--surface) 80%, transparent);
    }
    #reader-reading-view #reader-chapter-text .reader-figure figcaption,
    #reader-reading-view #reader-chapter-text .reader-semantic-caption {
      margin: .55em auto 0;
      max-width: 680px;
      color: var(--text-muted);
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: .78em;
      line-height: 1.45;
      text-align: center;
    }
    #reader-reading-view #reader-chapter-text .reader-semantic-heading {
      margin: .45em 0 .7em;
      font-family: inherit;
      line-height: 1.25;
    }
    #reader-reading-view #reader-chapter-text .reader-semantic-heading-1 { font-size: 1.55em; }
    #reader-reading-view #reader-chapter-text .reader-semantic-heading-2 { font-size: 1.34em; }
    #reader-reading-view #reader-chapter-text .reader-semantic-heading-3 { font-size: 1.18em; }
    #reader-reading-view #reader-chapter-text .reader-semantic-quote {
      margin: .35em 0;
      padding: .15em 0 .15em .9em;
      border-left: 3px solid var(--border);
      color: color-mix(in srgb, var(--text) 88%, var(--text-muted));
    }
    #reader-reading-view #reader-chapter-text .reader-semantic-list-item {
      display: grid;
      grid-template-columns: 1.5em minmax(0, 1fr);
      gap: .2em;
      align-items: start;
    }
    #reader-reading-view #reader-chapter-text .reader-semantic-list-marker {
      color: var(--text-muted);
      text-align: right;
      user-select: none;
    }
    #reader-reading-view #reader-chapter-text .reader-semantic-pre,
    #reader-reading-view #reader-chapter-text .reader-semantic-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #reader-reading-view #reader-chapter-text .reader-semantic-pre {
      margin: .4em 0;
      padding: .75em;
      overflow-x: auto;
      white-space: pre-wrap;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface2);
    }
    #reader-reading-view #reader-chapter-text .epub-img-missing {
      display: block;
      margin: .85em auto;
      padding: 10px 12px;
      max-width: 520px;
      border: 1px dashed var(--border);
      border-radius: 10px;
      color: var(--text-muted);
      background: color-mix(in srgb, var(--surface2) 72%, transparent);
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: .78rem;
      line-height: 1.45;
      text-align: center;
    }
    #reader-reading-view #reader-chapter-text .reader-stage1-fallback-note {
      margin: 0 0 1em;
      padding: 9px 11px;
      border: 1px dashed var(--warn, #b57924);
      border-radius: 9px;
      color: var(--text-muted);
      background: var(--surface2);
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: .72rem;
      line-height: 1.4;
    }
    @media (max-width: 700px) {
      #reader-reading-view #reader-chapter-text .reader-figure {
        margin: .95em auto;
      }
      #reader-reading-view #reader-chapter-text .epub-img {
        max-height: 72dvh !important;
        border-radius: 5px;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureReadablePosition(book) {
  if (!book) return;
  const chapter = book.chapters?.[book.currentChapter || 0];
  const items = chapter?.paragraphs || [];
  if (!items.length) {
    book.currentParagraph = 0;
    return;
  }
  const current = Math.max(0, Math.min(Number(book.currentParagraph) || 0, items.length - 1));
  if (contentItemText(items[current]).trim() || isImageContentItem(items[current])) {
    book.currentParagraph = current;
    return;
  }
  book.currentParagraph = firstReadableContentIndex(items);
}

function chapterHasContent(items = []) {
  return items.some(item => isImageContentItem(item) || contentItemText(item).trim());
}

function rootHasVisibleContent(root) {
  if (!root) return false;
  if (root.querySelector('img[data-img-key], .reader-figure')) return true;
  return String(root.textContent || '').replace(/\s+/g, '').length > 0;
}


function stampSemanticLayoutClasses() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  for (const paragraph of root.querySelectorAll('.reader-paragraph.reader-semantic-layout')) {
    paragraph.classList.remove('reader-semantic-layout');
  }
  for (const semantic of root.querySelectorAll('.reader-semantic-block-style, .reader-semantic-chunk')) {
    semantic.closest('.reader-paragraph')?.classList.add('reader-semantic-layout');
  }
}

function stampContextRoot(deps) {
  const root = document.getElementById('reader-chapter-text');
  const book = deps.getCurrentBook?.();
  const chapterIndex = Math.max(0, Number(book?.currentChapter) || 0);
  const chapter = book?.chapters?.[chapterIndex];
  if (!root || !book || !chapter) return;
  root.dataset.readerBookId = String(book.id || book.importKey || book.title || 'book');
  root.dataset.readerChapterKey = String(chapter.sourcePath || chapter.id || chapterIndex);
}

function renderEmergencyFallback(deps, reason = '') {
  const root = document.getElementById('reader-chapter-text');
  const book = deps.getCurrentBook?.();
  const chapter = book?.chapters?.[book.currentChapter || 0];
  const items = chapter?.paragraphs || [];
  if (!root || !chapterHasContent(items)) return false;

  const active = Number(book?.currentParagraph || 0);
  const rows = items.map((item, index) => {
    if (isImageContentItem(item)) {
      const caption = String(item.caption || '').trim();
      return `<figure class="reader-figure reader-stage1-fallback-item" data-p="${index}"><img data-img-key="${escapeHtml(item.key || '')}" alt="${escapeHtml(item.alt || caption || '')}" class="epub-img">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
    }
    const text = contentItemText(item).trim();
    if (!text) return '';
    return `<div class="reader-paragraph${index === active ? ' active' : ''} reader-stage1-fallback-item" data-p="${index}"><div class="reader-paragraph-text">${escapeHtml(text)}</div></div>`;
  }).join('');

  const detail = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  root.innerHTML = `<div class="reader-stage1-fallback-note">⚠ Включён упрощённый режим отображения: основной рендер вернул пустую страницу${detail ? ` · ${escapeHtml(detail)}` : ''}</div>${rows}`;
  stampContextRoot(deps);
  try { globalThis.__readerStage1FallbackReason = detail || 'empty semantic render'; } catch {}
  try { deps.loadEpubImages?.(); } catch (error) { console.warn('[reader stage1 fallback] image load failed', error); }
  try { deps.bindParagraphEvents?.(); } catch {}
  try { deps.bindVisibleParagraphTracking?.(); } catch {}
  return true;
}

export function createReaderChapterRenderer(deps) {
  ensureReaderStage1Styles();
  installFootnoteUi({ getCurrentBook: deps.getCurrentBook });
  installChapterSearch({ getCurrentBook: deps.getCurrentBook });

  const renderLegacy = deps.renderParagraphText;
  const trackLegacy = deps.trackParagraphSeen;
  const wrappedDeps = {
    ...deps,
    renderParagraphText: (item, index) => renderContentItem(item, index, {
      renderLegacy,
      escape: escapeHtml,
    }),
    trackParagraphSeen: (index, options) => {
      const book = deps.getCurrentBook?.();
      const chapter = book?.chapters?.[book.currentChapter || 0];
      const items = chapter?.paragraphs || [];
      const original = items[index];
      const text = contentItemText(original);
      if (!text.trim()) return false;
      if (typeof original === 'string') return trackLegacy(index, options);

      items[index] = text;
      try { return trackLegacy(index, options); }
      finally { items[index] = original; }
    },
  };

  const base = createBaseRenderer(wrappedDeps);
  return {
    ...base,
    render() {
      ensureReadablePosition(deps.getCurrentBook?.());
      let result;
      try {
        result = base.render();
        stampContextRoot(deps);
        stampSemanticLayoutClasses();
      } catch (error) {
        console.error('[reader stage1] semantic render failed', error);
        renderEmergencyFallback(deps, error?.message || String(error));
        return false;
      }

      try { refreshChapterSearchAfterRender(); } catch (error) {
        console.warn('[reader chapter search] refresh failed', error);
      }

      setTimeout(() => {
        const root = document.getElementById('reader-chapter-text');
        const book = deps.getCurrentBook?.();
        const chapter = book?.chapters?.[book.currentChapter || 0];
        const items = chapter?.paragraphs || [];
        if (chapterHasContent(items) && !rootHasVisibleContent(root)) {
          console.error('[reader stage1] renderer returned an empty chapter');
          renderEmergencyFallback(deps, 'empty chapter root');
        }
      }, 0);
      return result;
    },
  };
}

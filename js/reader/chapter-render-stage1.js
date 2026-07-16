import { createReaderChapterRenderer as createBaseRenderer } from './chapter-render-next.js?v=12';

const STYLE_ID = 'reader-stage1-format-style';

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
    #reader-reading-view #reader-chapter-text .epub-img {
      display: block !important;
      width: auto !important;
      max-width: 100% !important;
      height: auto !important;
      max-height: min(78dvh, 900px) !important;
      object-fit: contain !important;
      margin: 1.15em auto !important;
      border-radius: 8px;
      background: color-mix(in srgb, var(--surface) 80%, transparent);
    }
    #reader-reading-view #reader-chapter-text .reader-paragraph-text {
      overflow-wrap: anywhere;
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
    @media (max-width: 700px) {
      #reader-reading-view #reader-chapter-text .epub-img {
        max-height: 72dvh !important;
        margin: .95em auto !important;
        border-radius: 5px;
      }
    }
  `;
  document.head.appendChild(style);
}

export function createReaderChapterRenderer(deps) {
  ensureReaderStage1Styles();
  return createBaseRenderer(deps);
}

import { contentItemText } from './semantic-content.js?v=4';

const STYLE_ID = 'reader-footnote-stage1-style';
const LAYER_ID = 'reader-footnote-layer';
let getCurrentBook = () => null;
let activeText = '';
let eventsInstalled = false;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view .reader-footnote-ref {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--accent);
      font: inherit;
      font-size: .58em;
      font-weight: 700;
      line-height: 1;
      vertical-align: super;
      padding: .08em .18em;
      margin: 0 .03em;
      border-radius: .35em;
      cursor: pointer;
      text-decoration: none;
    }
    #reader-reading-view .reader-footnote-ref:active {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
    }
    #${LAYER_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: none;
      align-items: flex-end;
      justify-content: center;
      padding: 12px;
      background: rgba(20, 16, 12, .38);
      backdrop-filter: blur(2px);
    }
    #${LAYER_ID}.open { display: flex; }
    #${LAYER_ID} .reader-footnote-sheet {
      width: min(720px, 100%);
      max-height: min(72dvh, 720px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 18px 18px 12px 12px;
      background: var(--surface, #fffaf2);
      color: var(--text, #2f271f);
      box-shadow: 0 -12px 40px rgba(30, 20, 12, .22);
      font-family: 'IBM Plex Sans', sans-serif;
    }
    #${LAYER_ID} .reader-footnote-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px 10px;
      border-bottom: 1px solid var(--border);
    }
    #${LAYER_ID} .reader-footnote-title {
      font-size: .95rem;
      font-weight: 750;
    }
    #${LAYER_ID} .reader-footnote-close,
    #${LAYER_ID} .reader-footnote-listen {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface2, #f3eee6);
      color: inherit;
      min-height: 38px;
      padding: 7px 13px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    #${LAYER_ID} .reader-footnote-close {
      width: 38px;
      padding: 0;
      font-size: 1.15rem;
    }
    #${LAYER_ID} .reader-footnote-body {
      overflow-y: auto;
      padding: 15px 17px 8px;
      font-family: var(--reader-font, Georgia, serif);
      font-size: min(1.12rem, 5vw);
      line-height: 1.62;
    }
    #${LAYER_ID} .reader-footnote-body p {
      margin: 0 0 .9em;
    }
    #${LAYER_ID} .reader-footnote-actions {
      display: flex;
      justify-content: flex-end;
      gap: 9px;
      padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
    }
  `;
  document.head.appendChild(style);
}

function ensureLayer() {
  ensureStyles();
  let layer = document.getElementById(LAYER_ID);
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = LAYER_ID;
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `
    <section class="reader-footnote-sheet" aria-labelledby="reader-footnote-title">
      <div class="reader-footnote-head">
        <div id="reader-footnote-title" class="reader-footnote-title">Примечание</div>
        <button type="button" class="reader-footnote-close" aria-label="Закрыть">×</button>
      </div>
      <div class="reader-footnote-body"></div>
      <div class="reader-footnote-actions">
        <button type="button" class="reader-footnote-listen">🔊 Слушать</button>
      </div>
    </section>`;
  document.body.appendChild(layer);
  return layer;
}

function noteText(note) {
  if (!note) return '';
  if (typeof note.text === 'string' && note.text.trim()) return note.text.trim();
  return (note.items || []).map(contentItemText).map(text => text.trim()).filter(Boolean).join('\n\n');
}

function renderNoteItems(note) {
  const items = Array.isArray(note?.items) ? note.items : [];
  if (!items.length) {
    const text = noteText(note);
    return text ? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` : '<p>Текст примечания не найден в EPUB.</p>';
  }
  const rows = items.map(item => {
    const text = contentItemText(item).trim();
    if (!text) return '';
    const tag = item?.type === 'heading' ? 'h3' : 'p';
    return `<${tag}>${escapeHtml(text).replace(/\n/g, '<br>')}</${tag}>`;
  }).filter(Boolean);
  return rows.join('') || '<p>Текст примечания не найден в EPUB.</p>';
}

function openFootnote(target, label = '') {
  const layer = ensureLayer();
  const book = getCurrentBook?.();
  const note = book?.footnotes?.[target] || null;
  activeText = noteText(note);
  const title = layer.querySelector('.reader-footnote-title');
  const body = layer.querySelector('.reader-footnote-body');
  const listen = layer.querySelector('.reader-footnote-listen');
  if (title) title.textContent = label ? `Примечание ${label}` : 'Примечание';
  if (body) body.innerHTML = renderNoteItems(note);
  if (listen) listen.disabled = !activeText;
  layer.classList.add('open');
  layer.setAttribute('aria-hidden', 'false');
}

function closeFootnote() {
  const layer = document.getElementById(LAYER_ID);
  if (!layer) return;
  layer.classList.remove('open');
  layer.setAttribute('aria-hidden', 'true');
  activeText = '';
}

function installEvents() {
  if (eventsInstalled) return;
  eventsInstalled = true;
  document.addEventListener('click', event => {
    const reference = event.target?.closest?.('.reader-footnote-ref');
    if (reference) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      openFootnote(reference.dataset.readerFootnoteTarget || '', reference.dataset.readerFootnoteLabel || reference.textContent || '');
      return;
    }
    const close = event.target?.closest?.('.reader-footnote-close');
    if (close) {
      event.preventDefault();
      closeFootnote();
      return;
    }
    const listen = event.target?.closest?.('.reader-footnote-listen');
    if (listen) {
      event.preventDefault();
      if (activeText) window.readerSpeakText?.(activeText);
      return;
    }
    const layer = document.getElementById(LAYER_ID);
    if (layer && event.target === layer) closeFootnote();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeFootnote();
  });
}

export function installFootnoteUi(options = {}) {
  if (typeof options.getCurrentBook === 'function') getCurrentBook = options.getCurrentBook;
  ensureLayer();
  installEvents();
}

export { noteText as footnotePlainText };

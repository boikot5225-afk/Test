// toc134 — Spanish UI parity with the mature English Reader.
// Presentation only: lexical/context owners remain es-reader-pipeline-v1 and
// es-context-batch-v1. Values below intentionally mirror en-unknown-gloss-v2.
const MODE_KEY = 'an2_reader_es_unknown_gloss_mode_v1';
const STYLE_ID = 'rd-es-parity-ui-v1-style';
const ROW_ID = 'rd-dp-es-unknown-gloss-row';

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'spanish' || raw === 'español' || raw === 'es' || raw.startsWith('es-') ? 'es' : raw;
}

function mode() {
  try { return localStorage.getItem(MODE_KEY) === 'off' ? 'off' : 'unknown'; }
  catch { return 'unknown'; }
}

function enabled() { return mode() === 'unknown'; }

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Disabled = genuinely ordinary text. The toc133 wrappers stay in DOM so
       enabling help is instant, but they must not reserve vertical space. */
    #reader-reading-view.rd-es-pipeline-v1:not(.rd-es-unknown-gloss) .rw-es-v1-wrap{
      display:inline!important;position:static!important;vertical-align:baseline!important;
      line-height:inherit!important;margin:0!important;padding:0!important;
      overflow:visible!important;white-space:normal!important
    }
    #reader-reading-view.rd-es-pipeline-v1:not(.rd-es-unknown-gloss) .rw-es-v1-wrap>.reader-word{
      display:inline!important;margin:0!important;padding:0!important;line-height:inherit!important;
      white-space:normal!important;word-break:normal!important;overflow-wrap:normal!important
    }
    #reader-reading-view.rd-es-pipeline-v1:not(.rd-es-unknown-gloss) .rw-es-v1-gloss{display:none!important}

    /* Enabled = the same geometry as English Unknown gloss v5. */
    #reader-reading-view.rd-es-pipeline-v1.rd-es-unknown-gloss .reader-paragraph-text{line-height:1.86!important}
    #reader-reading-view.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-wrap{
      display:inline-block!important;vertical-align:-.36em!important;line-height:1!important;
      margin:0 .025em!important;padding:0 0 .56em!important;position:relative!important;
      overflow:visible!important;white-space:nowrap!important
    }
    #reader-reading-view.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-wrap>.reader-word{
      display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;
      white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important
    }
    #reader-reading-view.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-gloss{
      display:block!important;position:absolute!important;left:50%!important;bottom:0!important;
      transform:translateX(-50%)!important;max-width:none!important;white-space:nowrap!important;
      pointer-events:none!important;font-family:'IBM Plex Sans',sans-serif!important;
      font-size:var(--es-v1-gloss-font,.38em)!important;font-weight:400!important;line-height:1!important;
      color:var(--text-muted)!important;text-decoration:none!important
    }
    #reader-reading-view.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-gloss:empty{display:none!important}

    /* One vocabulary owner at a time. The screenshot that triggered toc134
       showed several W buttons because each language module exposed its own. */
    #reader-reading-view.rd-es-language-active #reader-en-vocab-btn,
    #reader-reading-view.rd-es-language-active #reader-fr-vocab-btn,
    #reader-reading-view.rd-es-language-active #reader-vocab-btn{display:none!important}
    #reader-reading-view.rd-es-language-active #reader-es-vocab-btn{display:inline-flex!important}
  `;
  document.head.appendChild(style);
}

function ensureControl() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return null;
  let row = document.getElementById(ROW_ID);
  if (!row) {
    row = document.createElement('div');
    row.id = ROW_ID;
    row.className = 'rd-dp-row';
    row.style.display = 'none';
    row.innerHTML = `<span class="rd-dp-label">Español · Unknown words</span><div class="rd-dp-pills"><button type="button" class="rd-dp-pill rd-es-gloss-mode" data-mode="off">Обычный текст</button><button type="button" class="rd-dp-pill rd-es-gloss-mode" data-mode="unknown">Русский под Unknown</button></div>`;
    row.querySelectorAll('.rd-es-gloss-mode').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    panel.appendChild(row);
  }
  return row;
}

function sync() {
  injectStyles();
  const view = document.getElementById('reader-reading-view');
  if (!view) return false;
  const isEs = currentLang() === 'es';
  view.classList.toggle('rd-es-language-active', isEs);
  view.classList.toggle('rd-es-unknown-gloss', isEs && enabled());
  const row = ensureControl();
  if (row) {
    row.style.display = isEs ? 'flex' : 'none';
    row.querySelectorAll('.rd-es-gloss-mode').forEach(button => {
      button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
    });
  }
  return true;
}

function setMode(next) {
  try { localStorage.setItem(MODE_KEY, next === 'off' ? 'off' : 'unknown'); } catch {}
  sync();
  // No re-tokenization: wrappers/glosses already exist. This only changes CSS.
  try { window.dispatchEvent(new CustomEvent('reader:es-gloss-mode-changed', { detail: { mode: mode() } })); } catch {}
}

function boot() {
  injectStyles();
  ensureControl();
  sync();
}

if (typeof window !== 'undefined' && !window.__readerEsParityUiV1) {
  window.__readerEsParityUiV1 = true;
  globalThis.readerSpanishGlossMode = mode;
  globalThis.readerSetSpanishGlossMode = setMode;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', sync);
  window.addEventListener('an2:languagechange', sync);
  window.addEventListener('reader:pagechange', sync);
  window.addEventListener('reader:es-pipeline-v1-ready', sync);
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#rd-display-panel,#reader-es-vocab-btn,#reader-en-vocab-btn,#reader-fr-vocab-btn,#reader-vocab-btn')) {
      queueMicrotask(sync);
    }
  }, true);
}

export { mode, setMode, sync };

// Final presentation layer for Chinese Unknown annotations.
//
// Older stability CSS deliberately clips pinyin/Russian to the Hanzi width so
// asynchronously resolved hints can never repaginate a chapter. That geometry
// is stable, but Russian becomes unreadable on a phone. This opt-in override
// keeps the same DOM, vocabulary state and event handlers while turning only a
// confirmed Unknown token into an intrinsic-width interlinear block:
// pinyin / Hanzi / full meaning. Long meanings wrap inside the token instead
// of painting over neighbours or being cut into fragments.

// Page mode groups whole paragraphs and gives each page its own vertical
// scroller. A wider Unknown token can therefore reflow its paragraph without
// changing chapter/page identity or rebuilding navigation.

const STYLE_ID = 'reader-zh-unknown-interlinear-v1';

function injectInterlinearStyle() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Three readable rows need a little more breathing room than the old
       clipped lane. This remains scoped to the optional Chinese gloss mode. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height:2.48 !important;
    }

    /* Only confirmed, visible Unknown words become content-width blocks.
       Known and pending tokens retain the old stable Hanzi footprint. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) {
      display:inline-grid !important;
      grid-template-rows:minmax(.58em,auto) 1.08em minmax(.62em,auto) !important;
      grid-template-columns:max-content !important;
      align-items:center !important;
      justify-items:center !important;
      vertical-align:-.56em !important;
      line-height:1 !important;
      margin:0 .08em !important;
      padding:0 .035em !important;
      position:relative !important;
      overflow:visible !important;
      width:max-content !important;
      min-width:0 !important;
      max-width:min(9.4em,46vw) !important;
      height:auto !important;
      box-sizing:border-box !important;
      break-inside:avoid !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) > .reader-word {
      grid-row:2 !important;
      grid-column:1 !important;
      align-self:center !important;
      justify-self:center !important;
      display:inline !important;
      position:static !important;
      margin:0 !important;
      padding:0 1px !important;
      line-height:1.08 !important;
      white-space:nowrap !important;
      word-break:keep-all !important;
      overflow-wrap:normal !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::after {
      display:block !important;
      position:static !important;
      left:auto !important;
      top:auto !important;
      bottom:auto !important;
      transform:none !important;
      grid-column:1 !important;
      align-self:center !important;
      justify-self:center !important;
      width:max-content !important;
      min-width:100% !important;
      max-width:min(9.4em,46vw) !important;
      height:auto !important;
      margin:0 !important;
      padding:0 .04em !important;
      box-sizing:border-box !important;
      overflow:visible !important;
      text-overflow:clip !important;
      text-align:center !important;
      pointer-events:none !important;
      font-family:'IBM Plex Sans',system-ui,sans-serif !important;
      transition:none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::before {
      grid-row:1 !important;
      content:attr(data-zh-gloss-sticky-pinyin) !important;
      white-space:nowrap !important;
      overflow-wrap:normal !important;
      font-size:.50em !important;
      font-weight:500 !important;
      line-height:1 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::after {
      grid-row:3 !important;
      content:attr(data-zh-gloss-sticky-ru) !important;
      white-space:normal !important;
      overflow-wrap:anywhere !important;
      word-break:normal !important;
      hyphens:none !important;
      font-size:.46em !important;
      font-weight:400 !important;
      line-height:1.08 !important;
      opacity:.96 !important;
    }

    /* The top 拼 control remains authoritative. Hiding pinyin must not leave a
       phantom first row that wastes additional vertical space. */
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) {
      grid-template-rows:1.08em minmax(.62em,auto) !important;
      vertical-align:-.38em !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) > .reader-word {
      grid-row:1 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::after {
      grid-row:2 !important;
    }
  `;
  document.head.appendChild(style);
}

function install() {
  injectInterlinearStyle();
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
  window.addEventListener('pageshow', install);
}

export { injectInterlinearStyle };

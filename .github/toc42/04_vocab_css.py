from pathlib import Path

p = Path('js/reader/vocab-estimate.js')
t = p.read_text('utf-8')
start_marker = '    /* Let the existing Chinese gloss layer follow Known / Unknown from the\n'
start = t.index(start_marker)
end = t.index('    #${MODAL_ID} {', start)
stable = r'''    /* Known/Unknown does not own text geometry. The exact toc36 Chinese
       annotation grid remains authoritative; these rules only decide visibility. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown) {
      display:inline-grid !important;
      grid-template-rows:.58em 1.08em .54em !important;
      grid-template-columns:max-content !important;
      align-items:center !important;
      justify-items:center !important;
      vertical-align:-.48em !important;
      line-height:1 !important;
      margin:0 .055em !important;
      padding:0 .025em !important;
      position:relative !important;
      overflow:visible !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown) > .reader-word {
      grid-row:2 !important;
      grid-column:1 !important;
      align-self:center !important;
      justify-self:center !important;
      display:inline !important;
      margin:0 !important;
      padding:0 1px !important;
      line-height:1.08 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::after {
      display:block !important;
      position:static !important;
      left:auto !important;
      top:auto !important;
      bottom:auto !important;
      transform:none !important;
      grid-column:1 !important;
      justify-self:center !important;
      width:max-content !important;
      min-width:100% !important;
      max-width:6.4em !important;
      height:auto !important;
      margin:0 !important;
      padding:0 !important;
      overflow:hidden !important;
      text-overflow:ellipsis !important;
      white-space:nowrap !important;
      text-align:center !important;
      pointer-events:none !important;
      line-height:1 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::before {
      grid-row:1 !important;
      align-self:end !important;
      content:attr(data-zh-gloss-pinyin) !important;
      font-size:.51em !important;
      font-weight:500 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::after {
      grid-row:3 !important;
      align-self:start !important;
      content:attr(data-zh-gloss-ru-readable) !important;
      font-size:.46em !important;
      font-weight:400 !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::after {
      content:'' !important;
      display:none !important;
    }

'''
t = t[:start] + stable + t[end:]

anchor = "    #${MODAL_ID} .rve-known-baseline span { color:#d7cfe2;font-size:.8rem; }\n"
assert anchor in t
t = t.replace(anchor, anchor + r'''    #${MODAL_ID} .rve-dashboard { max-width:520px;margin:4vh auto 0;text-align:center; }
    #${MODAL_ID} .rve-stat-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:24px 0 8px; }
    #${MODAL_ID} .rve-stat-grid > div { min-height:92px;padding:13px 8px;border-radius:16px;background:rgba(255,255,255,.07);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px; }
    #${MODAL_ID} .rve-stat-grid b { font-size:1.45rem;color:#19d0b0; }
    #${MODAL_ID} .rve-stat-grid span { color:#c9bfd7;font-size:.72rem;line-height:1.3; }
''' , 1)

p.write_text(t, 'utf-8')

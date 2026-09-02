#!/usr/bin/env python3
import json
import pathlib

from reader_cdp import ReaderCDP

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)

cdp = ReaderCDP(connect_timeout=55)
cdp.connect()
cdp.wait("document.readyState==='complete'", 55)

result = cdp.eval(r"""(async()=>{
  const mod=await import('./js/reader/epub-stage1-real.js?v=toc131-dropcap');
  const cases=[
    {
      name:'single-letter-accent',
      html:'<!doctype html><html><body><h1>2</h1><div class="first"><div class="let">  É  </div>clair avance sans coupure.</div><p>Suite.</p></body></html>',
      expected:'Éclair avance sans coupure.',
    },
    {
      name:'nested-emphasis',
      html:'<!doctype html><html><body><div class="first"><div class="let"><em>M</em></div><em>a phrase reste entière.</em></div></body></html>',
      expected:'Ma phrase reste entière.',
    },
    {
      name:'dialogue-prefix',
      html:'<!doctype html><html><body><div class="first"><div class="let"><span>—</span>&nbsp;C’</div>est pourquoi le texte continue.</div></body></html>',
      expected:'— C’est pourquoi le texte continue.',
    },
  ];
  const out=[];
  for(const item of cases){
    const parsed=mod.htmlToSemanticItems(item.html);
    const texts=parsed.map(x=>mod.semanticItemText(x)).filter(Boolean);
    out.push({
      name:item.name,
      expected:item.expected,
      texts,
      exact:texts.includes(item.expected),
      splitPrefix:texts.some(x=>['É','M','— C’','— C\''].includes(x)),
    });
  }
  const control=mod.htmlToSemanticItems('<!doctype html><html><body><div><p>Alpha.</p><p>Beta.</p></div></body></html>')
    .map(x=>mod.semanticItemText(x)).filter(Boolean);
  return {cases:out, control};
})()""", 30)

(OUT / 'toc131-epub-dropcap-live.json').write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8'
)
print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)

if not result or len(result.get('cases', [])) != 3:
    raise RuntimeError('drop-cap audit returned incomplete result')
for case in result['cases']:
    if not case.get('exact'):
        raise RuntimeError('EPUB opening text was split or truncated: ' + repr(case))
    if case.get('splitPrefix'):
        raise RuntimeError('drop-cap prefix remained a separate semantic block: ' + repr(case))
if result.get('control') != ['Alpha.', 'Beta.']:
    raise RuntimeError('ordinary nested block parsing regressed: ' + repr(result))

cdp.close()

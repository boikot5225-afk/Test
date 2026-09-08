#!/usr/bin/env python3
"""Install a deterministic in-WebView readerAI stub for the toc134 parity fixture.

The frozen toc133 live context audit runs first and restores the real Firebase
object. toc134 then needs to prove that a Spanish Unknown with no local WikDict
entry does not stay blank: the production inline bridge must immediately fall
through to the existing conservative paragraph context path. This stub keeps
that Android UI gate deterministic without changing product code or confidence
rules.
"""
from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

ok = cdp.eval(r"""(()=>{
  const calls=[];
  const fake={
    app(){
      return {
        functions(){
          return {
            httpsCallable(name){
              if(name!=='readerAI') throw new Error('unexpected callable '+name);
              return async payload=>{
                calls.push(JSON.parse(JSON.stringify(payload||{})));
                const items=(payload?.targets||[]).map(target=>{
                  const surface=String(target?.surface||'').toLowerCase();
                  if(surface==='cometerlos') return {id:target.id,ru:'совершать',lemma:'cometer',pos:'verb',confidence:.99,note:'toc134 deterministic clitic context'};
                  if(surface==='bastaron') return {id:target.id,ru:'хватить',lemma:'bastar',pos:'verb',confidence:.99,note:'toc134 deterministic conjugation context'};
                  const local=String(target?.localRu||'').trim();
                  return {id:target.id,ru:local,lemma:String(target?.lemma||surface),pos:'other',confidence:local?.99:.40,note:''};
                });
                return {data:{items}};
              };
            },
          };
        },
      };
    },
  };
  globalThis.__toc134ParityOriginalFirebase=globalThis.firebase;
  globalThis.__toc134ParityOriginalFallbackFirebase=globalThis.__AN2_FALLBACK_FIREBASE;
  globalThis.__toc134ParityContextCalls=calls;
  globalThis.firebase=fake;
  globalThis.__AN2_FALLBACK_FIREBASE=null;
  return typeof globalThis.firebase?.app==='function';
})()""")
cdp.close()
if not ok:
    raise RuntimeError('toc134 deterministic Spanish context stub was not installed')
print('toc134 deterministic Spanish context stub: PASS')

#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for Spanish context audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!view||!root) throw new Error('Reader DOM missing');
  view.style.display='block';
  view.dataset.readerLang='es';
  root.dataset.lang='es';
  root.dataset.readerBookId='toc133-es-context-audit';
  root.dataset.renderedChapter='8';
  root.innerHTML=`
    <div class="reader-paragraph" data-p="0"><div class="reader-paragraph-text">
      Se sentó en el <span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="banco" data-lang="es">banco</span><span class="rw-es-v1-gloss" aria-hidden="true">банк</span></span> del parque.
    </div></div>
    <div class="reader-paragraph" data-p="1"><div class="reader-paragraph-text">
      Depositó dinero en el <span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="banco" data-lang="es">banco</span><span class="rw-es-v1-gloss" aria-hidden="true">банк</span></span>.
    </div></div>
    <div class="reader-paragraph" data-p="2"><div class="reader-paragraph-text">
      Fue un arreglo <span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="raro" data-lang="es">raro</span><span class="rw-es-v1-gloss" aria-hidden="true">редкий</span></span>.
    </div></div>
    <div class="reader-paragraph" data-p="3"><div class="reader-paragraph-text">
      <span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="Madrid" data-lang="es">Madrid</span><span class="rw-es-v1-gloss" aria-hidden="true">Мадрид</span></span> estaba tranquilo.
    </div></div>`;

  [...root.querySelectorAll('.reader-paragraph')].forEach((paragraph,index)=>{
    const top=80+(index*90);
    paragraph.getBoundingClientRect=()=>({x:20,y:top,left:20,top,right:620,bottom:top+64,width:600,height:64,toJSON(){return this;}});
  });

  const oldFirebase=globalThis.firebase;
  const oldFallback=globalThis.__AN2_FALLBACK_FIREBASE;
  const oldLemma=globalThis.readerSpanishLemmaFor;
  const calls=[];
  globalThis.readerSpanishLemmaFor=(word)=>String(word||'').toLocaleLowerCase('es-ES');
  const fake={
    app(){return {functions(){return {httpsCallable(name){
      if(name!=='readerAI') throw new Error('unexpected callable '+name);
      return async payload=>{
        calls.push(JSON.parse(JSON.stringify(payload)));
        const context=String(payload.context||'');
        const items=(payload.targets||[]).map(target=>{
          const word=String(target.surface||'').toLowerCase();
          if(word==='banco' && /parque/i.test(context)) return {id:target.id,ru:'скамейка',lemma:'banco',pos:'noun',confidence:.97,note:''};
          if(word==='banco' && /depositó/i.test(context)) return {id:target.id,ru:'банк',lemma:'banco',pos:'noun',confidence:.98,note:''};
          if(word==='raro') return {id:target.id,ru:'странный',lemma:'raro',pos:'adjective',confidence:.60,note:''};
          if(word==='madrid') return {id:target.id,ru:'',lemma:'Madrid',pos:'proper_noun',confidence:.99,note:''};
          return {id:target.id,ru:String(target.localRu||''),lemma:String(target.lemma||word),pos:'other',confidence:.91,note:''};
        });
        return {data:{items}};
      };
    }}};}};
  globalThis.firebase=fake;
  globalThis.__AN2_FALLBACK_FIREBASE=null;
  try {
    const cacheKey=globalThis.an2ReaderStorageKey?.('an2_reader_es_context_batch_v1')||'an2_reader_es_context_batch_v1';
    localStorage.removeItem(cacheKey);
    const shared=globalThis.__readerEsContextBatchV1;
    if(shared){
      shared.cache=null;
      shared.inFlight?.clear?.();
      clearTimeout(shared.timer);clearTimeout(shared.retryTimer);
      shared.timer=0;shared.retryTimer=0;
    }
    const mod=await import('./js/reader/es-context-batch-v1.js?v=77.42-toc133-live-audit');
    const fresh=globalThis.__readerEsContextBatchV1;
    if(fresh){fresh.cache=null;fresh.inFlight?.clear?.();}
    await mod.refine('live-audit');
    await new Promise(r=>setTimeout(r,200));

    const rows=[...root.querySelectorAll('.reader-paragraph')].map(p=>{
      const word=p.querySelector('.reader-word');
      const wrap=word?.parentElement?.classList?.contains('rw-es-v1-wrap')?word.parentElement:null;
      return {
        p:p.dataset.p,
        word:String(word?.dataset.word||''),
        ru:String(wrap?.querySelector('.rw-es-v1-gloss')?.textContent||'').trim(),
        provider:String(wrap?.dataset.esProvider||''),
        key:String(wrap?.dataset.esContextKey||word?.dataset?.esContextKey||''),
        proper:!!word?.classList?.contains('rw-es-proper'),
      };
    });
    const batchCalls=calls.filter(call=>call?.task==='es_context_batch'&&call?.sourceLang==='es');
    return {rows,calls:batchCalls};
  } finally {
    globalThis.firebase=oldFirebase;
    globalThis.__AN2_FALLBACK_FIREBASE=oldFallback;
    globalThis.readerSpanishLemmaFor=oldLemma;
  }
})()""", 45)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('Spanish context audit returned no result')
rows = {row['p']: row for row in result.get('rows', [])}
if rows.get('0', {}).get('ru') != 'скамейка' or rows.get('0', {}).get('provider') != 'context-deepseek-batch':
    raise RuntimeError('park-banco contextual gloss failed: ' + repr(result))
if rows.get('1', {}).get('ru') != 'банк' or rows.get('1', {}).get('provider') != 'context-deepseek-batch':
    raise RuntimeError('financial-banco contextual gloss failed: ' + repr(result))
if rows.get('0', {}).get('key') == rows.get('1', {}).get('key'):
    raise RuntimeError('Same Spanish surface reused one occurrence cache key across contexts: ' + repr(result))
if rows.get('2', {}).get('ru') != 'редкий' or rows.get('2', {}).get('provider'):
    raise RuntimeError('Low-confidence AI overwrote offline Spanish gloss: ' + repr(result))
if not rows.get('3', {}).get('proper') or rows.get('3', {}).get('ru'):
    raise RuntimeError('Spanish proper noun was translated instead of suppressed: ' + repr(result))
if len(result.get('calls', [])) != 4:
    raise RuntimeError('Spanish batch did not drain all four visible paragraphs: ' + repr(result))
for call in result['calls']:
    if call.get('task') != 'es_context_batch' or call.get('sourceLang') != 'es' or not call.get('context') or not call.get('targets'):
        raise RuntimeError('Malformed Spanish context batch payload: ' + repr(result))

cdp.close()

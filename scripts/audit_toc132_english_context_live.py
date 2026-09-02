#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for English context audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!view||!root) throw new Error('Reader DOM missing');
  view.dataset.readerLang='en';
  root.dataset.lang='en';
  root.dataset.readerBookId='toc132-en-context-audit';
  root.dataset.renderedChapter='7';
  root.innerHTML=`
    <div class="reader-paragraph" data-p="0"><div class="reader-paragraph-text">
      He sat on the <span class="rw-en-gloss-wrap" data-en-gloss="1" data-en-gloss-visible="1"><span class="reader-word rw-migaku-unknown" data-word="bank" data-lang="en">bank</span><span class="rw-en-gloss-text">банк</span></span> of the river.
    </div></div>
    <div class="reader-paragraph" data-p="1"><div class="reader-paragraph-text">
      She went to the <span class="rw-en-gloss-wrap" data-en-gloss="1" data-en-gloss-visible="1"><span class="reader-word rw-migaku-unknown" data-word="bank" data-lang="en">bank</span><span class="rw-en-gloss-text">банк</span></span> to deposit cash.
    </div></div>
    <div class="reader-paragraph" data-p="2"><div class="reader-paragraph-text">
      It was a <span class="rw-en-gloss-wrap" data-en-gloss="1" data-en-gloss-visible="1"><span class="reader-word rw-migaku-unknown" data-word="peculiar" data-lang="en">peculiar</span><span class="rw-en-gloss-text">особенный</span></span> arrangement.
    </div></div>
    <div class="reader-paragraph" data-p="3"><div class="reader-paragraph-text">
      <span class="rw-en-gloss-wrap" data-en-gloss="1" data-en-gloss-visible="1"><span class="reader-word rw-migaku-unknown" data-word="London" data-lang="en">London</span><span class="rw-en-gloss-text">Лондон</span></span> was quiet.
    </div></div>`;

  const oldFirebase=globalThis.firebase;
  const oldFallback=globalThis.__AN2_FALLBACK_FIREBASE;
  const calls=[];
  const fake={
    app(){return {functions(){return {httpsCallable(name){
      if(name!=='readerAI') throw new Error('unexpected callable '+name);
      return async payload=>{
        calls.push(JSON.parse(JSON.stringify(payload)));
        const context=String(payload.context||'');
        const items=(payload.targets||[]).map(target=>{
          const word=String(target.surface||'');
          if(word.toLowerCase()==='bank' && /river/i.test(context)) return {id:target.id,ru:'берег',lemma:'bank',pos:'noun',confidence:.97,note:''};
          if(word.toLowerCase()==='bank' && /deposit/i.test(context)) return {id:target.id,ru:'банк',lemma:'bank',pos:'noun',confidence:.98,note:''};
          if(word.toLowerCase()==='peculiar') return {id:target.id,ru:'странный',lemma:'peculiar',pos:'adjective',confidence:.60,note:''};
          if(word.toLowerCase()==='london') return {id:target.id,ru:'',lemma:'London',pos:'proper_noun',confidence:.99,note:''};
          return {id:target.id,ru:String(target.localRu||''),lemma:String(target.lemma||word),pos:'other',confidence:.90,note:''};
        });
        return {data:{items}};
      };
    }}};}};
  };
  globalThis.firebase=fake;
  globalThis.__AN2_FALLBACK_FIREBASE=null;
  try {
    const mod=await import('./js/reader/en-context-batch-v2.js?v=77.42-toc132-live-audit');
    localStorage.removeItem(globalThis.an2ReaderStorageKey?.('an2_reader_en_context_batch_v2')||'an2_reader_en_context_batch_v2');
    const shared=globalThis.__readerEnContextBatchV2;
    if(shared){
      shared.cache=null;
      shared.active=0;
      shared.inFlight?.clear?.();
      clearTimeout(shared.timer);
      clearTimeout(shared.retryTimer);
      shared.timer=0;
      shared.retryTimer=0;
    }
    await mod.refine('live-audit');
    await new Promise(r=>setTimeout(r,1400));

    const rows=[...root.querySelectorAll('.reader-paragraph')].map(p=>{
      const word=p.querySelector('.reader-word');
      const wrap=word?.parentElement;
      return {
        p:p.dataset.p,
        word:String(word?.dataset.word||''),
        ru:String(wrap?.querySelector('.rw-en-gloss-text')?.textContent||'').trim(),
        provider:String(wrap?.dataset.enContextProvider||''),
        key:String(wrap?.dataset.enContextKey||''),
        batch:String(wrap?.dataset.enContextBatch||''),
      };
    });
    const batchCalls=calls.filter(call=>call?.task==='en_context_batch'&&call?.sourceLang==='en');
    return {rows,calls:batchCalls,threshold:mod.MIN_CONFIDENCE};
  } finally {
    globalThis.firebase=oldFirebase;
    globalThis.__AN2_FALLBACK_FIREBASE=oldFallback;
  }
})()""", 45)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('English context audit returned no result')
if abs(float(result.get('threshold', 0)) - 0.84) > 1e-9:
    raise RuntimeError('English context confidence gate changed: ' + repr(result))
rows = {row['p']: row for row in result.get('rows', [])}
if rows.get('0', {}).get('ru') != 'берег' or rows.get('0', {}).get('provider') != 'deepseek-context':
    raise RuntimeError('river-bank contextual gloss failed: ' + repr(result))
if rows.get('1', {}).get('ru') != 'банк' or rows.get('1', {}).get('provider') != 'deepseek-context':
    raise RuntimeError('Financial-bank contextual gloss failed: ' + repr(result))
if rows.get('0', {}).get('key') == rows.get('1', {}).get('key'):
    raise RuntimeError('Same English surface reused one occurrence cache key across contexts: ' + repr(result))
if rows.get('2', {}).get('ru') != 'особенный' or rows.get('2', {}).get('provider'):
    raise RuntimeError('Low-confidence AI overwrote offline English gloss: ' + repr(result))
if rows.get('3', {}).get('ru') != 'Лондон' or rows.get('3', {}).get('provider'):
    raise RuntimeError('Proper-name AI result erased/overrode English gloss: ' + repr(result))
if len(result.get('calls', [])) < 4:
    raise RuntimeError('Paragraph batch did not run for all English audit paragraphs: ' + repr(result))
for call in result['calls']:
    if call.get('task') != 'en_context_batch' or call.get('sourceLang') != 'en' or not call.get('context') or not call.get('targets'):
        raise RuntimeError('Malformed English context batch payload: ' + repr(result))

cdp.close()

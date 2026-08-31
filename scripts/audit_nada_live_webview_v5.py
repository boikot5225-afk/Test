#!/usr/bin/env python3
import base64, json, pathlib, time
import requests, websocket

OUT = pathlib.Path('runtime-audit'); OUT.mkdir(exist_ok=True)
pages=[]
for _ in range(80):
    try: pages=requests.get('http://127.0.0.1:9222/json/list',timeout=2).json()
    except Exception: pages=[]
    if pages: break
    time.sleep(.5)
if not pages: raise SystemExit('No debuggable WebView page')
page=next((p for p in pages if 'appassets.androidplatform.net' in p.get('url','')),pages[0])
ws=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=15,suppress_origin=True)
seq=0

def cdp(method,params=None):
    global seq
    seq+=1; ident=seq
    ws.send(json.dumps({'id':ident,'method':method,'params':params or {}}))
    while True:
        msg=json.loads(ws.recv())
        if msg.get('id')==ident:
            if 'error' in msg: raise RuntimeError(msg['error'])
            return msg.get('result',{})

def ev(code):
    r=cdp('Runtime.evaluate',{'expression':code,'awaitPromise':True,'returnByValue':True,'userGesture':True})
    if r.get('exceptionDetails'): raise RuntimeError(str(r['exceptionDetails']))
    return r.get('result',{}).get('value')

def wait(code,timeout=40):
    end=time.time()+timeout; last=None
    while time.time()<end:
        try:
            last=ev(code)
            if last: return last
        except Exception as exc: last=str(exc)
        time.sleep(.35)
    raise RuntimeError(f'wait timeout: {code}; last={last}')

def click_word(word):
    q=json.dumps(word.lower(),ensure_ascii=False)
    return ev(f"(()=>{{const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')==={q});if(!e)return 'MISSING';e.click();return e.dataset.word}})()")

cdp('Runtime.enable'); cdp('Page.enable')
audit={'page':page,'steps':{},'bugs':[]}
wait("document.readyState==='complete'")
audit['steps']['initial']=ev("document.body.innerText.slice(0,1600)")
if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked=ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    audit['steps']['guest_click']=clicked
    if not clicked: raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'",20)
audit['steps']['main_ready']=True

# Give the real ACTION_VIEW path a chance, record its result, then continue the
# semantic audit through the same readerImportAndroidFile -> File -> EPUB parser
# path using a data URL if the native bridge failed.
time.sleep(3)
native_status=ev("document.querySelector('#reader-import-status')?.textContent||''")
audit['steps']['native_action_view_status']=native_status
if 'Android не передал файл' in native_status:
    audit['bugs'].append('Android ACTION_VIEW external EPUB import returns HTTP 500')

reading_ready="(()=>{const v=document.querySelector('#reader-reading-view');return !!(v&&getComputedStyle(v).display!=='none'&&document.querySelectorAll('#reader-chapter-text .reader-word').length>20)})()"
if not ev(reading_ready):
    data=base64.b64encode((OUT/'nada-runtime.epub').read_bytes()).decode('ascii')
    payload={'name':'nada-runtime.epub','mime':'application/epub+zip','url':'data:application/epub+zip;base64,'+data}
    audit['steps']['data_url_import_called']=ev("(async()=>{await window.readerImportAndroidFile("+json.dumps(payload)+");return true})()")
wait(reading_ready,65)
time.sleep(2)
audit['steps']['reading_text']=ev("document.querySelector('#reader-chapter-text')?.innerText?.slice(0,3600)||''")
audit['steps']['word_count']=ev("document.querySelectorAll('#reader-chapter-text .reader-word').length")
audit['steps']['reader_lang']=ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||document.getElementById('reader-chapter-text')?.dataset?.lang||''")
audit['steps']['globals']=ev("({lemma:typeof window.readerFrenchLemmaFor,lex:typeof window.readerFrenchLexicalAnalysisFor,proper:typeof window.readerFrenchIsProperWord,knowledge:typeof window.readerFrenchVocabularyKnowledgeFor})")

wait("typeof window.readerFrenchLemmaFor==='function' && window.readerFrenchLemmaFor('était')==='être'",30)
words=['fumant','raccrocha','était','fumait','puait','parvenait','leva','appeler','fini','former','avait','courant','personne']
audit['lemmas']=ev("(()=>{const ws="+json.dumps(words,ensure_ascii=False)+";return Object.fromEntries(ws.map(w=>[w,window.readerFrenchLemmaFor?.(w)||null]))})()")
lex={}
for word in ['fumant','raccrocha','former','pièce','arrêt','mec','courant','poule','fond','foutue','personne']:
    lex[word]=ev(f"(async()=>await window.readerFrenchLexicalAnalysisFor?.({json.dumps(word,ensure_ascii=False)})||null)()")
audit['lexical']=lex

audit['proper_names']=ev("(()=>{const ws=['Treuffais','Buenaventura','Épaulard','Catalan','Longuevache'];return Object.fromEntries(ws.map(w=>{const es=[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return [w,{proper:window.readerFrenchIsProperWord?.(w),knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),classes:es.map(e=>e.className)}]}))})()")
for name,item in audit['proper_names'].items():
    if item.get('classes') and not item.get('proper'):
        audit['bugs'].append(f'proper name not recognized locally: {name}')

# Exact manual-state regression.
click_word('fumant'); wait("document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==='fumant'",10); time.sleep(.8)
audit['fumant_panel']=ev("({analysis:document.querySelector('#reader-word-analysis')?.innerText||'',lemma:document.querySelector('#reader-word-lemma')?.value||'',pos:document.querySelector('#reader-word-pos')?.value||'',ru:document.querySelector('#reader-word-ru')?.value||'',source:document.querySelector('#reader-fr-knowledge-source')?.textContent||''})")
ev("document.querySelector('#reader-fr-unknown-btn')?.click();true"); time.sleep(1)
audit['fumant_first']=ev("(()=>{const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLowerCase()==='fumant');return {class:e?.className||'',manual:e?.dataset?.readerManualKnowledge||'',color:e?getComputedStyle(e).color:'',knowledge:window.readerFrenchVocabularyKnowledgeFor?.('fumant')}})()")
click_word('pièce'); wait("document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==='pièce'",10)
ev("document.querySelector('#reader-fr-unknown-btn')?.click();true"); time.sleep(1.4)
audit['after_second_unknown']=ev("(()=>{function s(w){const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return {class:e?.className||'',manual:e?.dataset?.readerManualKnowledge||'',color:e?getComputedStyle(e).color:'',knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),gloss:e?.parentElement?.querySelector('.rw-fr-gloss-text')?.textContent||''}}return {fumant:s('fumant'),piece:s('pièce')}})()")
fum=audit['after_second_unknown']['fumant']
if fum.get('manual')!='unknown': audit['bugs'].append('manual Unknown data disappeared after marking a second word')
if 'rw-migaku-unknown' not in fum.get('class',''): audit['bugs'].append('first word lost red Unknown class after marking a second word')

for word in ['arrêt','former','raccrocha','mec','courant','poule','fond','foutue']:
    if click_word(word)=='MISSING': continue
    try: wait(f"document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==={json.dumps(word.lower())}",6)
    except Exception: pass
    ev("document.querySelector('#reader-fr-unknown-btn')?.click();true"); time.sleep(.35)
time.sleep(12)
audit['problem_words']=ev("(()=>{const ws=['arrêt','former','raccrocha','mec','courant','poule','fond','foutue'];return Object.fromEntries(ws.map(w=>{const es=[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return [w,es.map(e=>({class:e.className,gloss:e.parentElement?.querySelector('.rw-fr-gloss-text')?.textContent||'',provider:e.parentElement?.dataset?.frContextProvider||'',ru:e.parentElement?.dataset?.frGlossRu||''}))]}))})()")
audit['all_glosses']=ev("(()=>[...document.querySelectorAll('.rw-fr-gloss-text')].map(e=>e.textContent||'').filter(Boolean))()")
audit['layout']=ev("(()=>{const gs=[...document.querySelectorAll('.rw-fr-gloss-text')].filter(e=>getComputedStyle(e).display!=='none');let overlaps=[];for(let i=0;i<gs.length;i++){const a=gs[i].getBoundingClientRect();for(let j=i+1;j<gs.length;j++){const b=gs[j].getBoundingClientRect();const x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(x>2&&y>2)overlaps.push({a:gs[i].textContent,b:gs[j].textContent,x,y});}}return {visibleGlosses:gs.length,overlaps:overlaps.slice(0,50)}})()")
for text in audit['all_glosses']:
    if '[' in text or ']' in text: audit['bugs'].append('broken bracket leaked into inline gloss: '+text)
OUT.joinpath('audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(audit,ensure_ascii=False,indent=2)); ws.close()

#!/usr/bin/env python3
import json, pathlib, time
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

def ev(code, await_promise=True):
    r=cdp('Runtime.evaluate',{'expression':code,'awaitPromise':await_promise,'returnByValue':True,'userGesture':True})
    obj=r.get('result',{})
    if obj.get('subtype')=='error': raise RuntimeError(obj.get('description','JS error'))
    return obj.get('value')

def wait(code,timeout=30):
    end=time.time()+timeout; last=None
    while time.time()<end:
        try:
            last=ev(code)
            if last: return last
        except Exception as exc: last=str(exc)
        time.sleep(.35)
    raise RuntimeError(f'timeout: {code}; last={last}')

def click_word(word):
    q=json.dumps(word.lower(),ensure_ascii=False)
    return ev(f"(()=>{{const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')==={q});if(!e)return 'MISSING';e.click();return e.dataset.word}})()")

def snapshot_word(word):
    q=json.dumps(word.lower(),ensure_ascii=False)
    return ev(f"(()=>{{const es=[...document.querySelectorAll('.reader-word[data-word]')].filter(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')==={q});return es.map(e=>{{const w=e.closest('.rw-fr-gloss-wrap')||e.parentElement;return {{word:e.dataset.word||'',class:e.className,color:getComputedStyle(e).color,knowledge:window.readerFrenchVocabularyKnowledgeFor?.(e.dataset.word||''),gloss:w?.querySelector('.rw-fr-gloss-text')?.textContent||'',provider:w?.dataset?.frContextProvider||'',ru:w?.dataset?.frGlossRu||''}}}})}})()")

cdp('Runtime.enable'); cdp('Page.enable')
audit={'page':page,'steps':{},'bugs':[]}
wait("document.readyState==='complete'")
audit['steps']['initial_body']=ev("document.body.innerText.slice(0,2200)")

# Cold ACTION_VIEW lands at auth on a clean install. Enter guest mode so the
# already queued native import can continue exactly through readerImportAndroidFile.
guest=ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
audit['steps']['guest_clicked']=guest
if guest:
    wait("(()=>{const m=document.querySelector('#main-app');return !!(m&&getComputedStyle(m).display!=='none')})()",20)

# First give MainActivity's queued ACTION_VIEW import a chance. If auth timing
# consumed that attempt, manually re-call the exact same exported bridge against
# the still-live native /android-import/current stream, only to continue audit.
auto=False
try:
    auto=bool(wait("(()=>document.querySelectorAll('#reader-chapter-text .reader-word').length>20)()",25))
except Exception:
    auto=False
audit['steps']['auto_import_after_guest']=auto
if not auto:
    audit['steps']['pre_manual_body']=ev("document.body.innerText.slice(0,2600)")
    manual=ev("(async()=>{if(typeof window.readerImportAndroidFile!=='function')return 'NO_IMPORT_FN';return await window.readerImportAndroidFile({name:'nada-runtime.epub',mime:'application/epub+zip',url:'https://appassets.androidplatform.net/android-import/current?audit=1'})})()")
    audit['steps']['manual_import_result']=manual
wait("(()=>document.querySelectorAll('#reader-chapter-text .reader-word').length>20)()",45)
time.sleep(2)

audit['steps']['reading_text']=ev("document.querySelector('#reader-chapter-text')?.innerText?.slice(0,4200)||''")
audit['steps']['word_count']=ev("document.querySelectorAll('#reader-chapter-text .reader-word').length")
audit['steps']['reader_lang']=ev("document.querySelector('#reader-reading-view')?.dataset?.readerLang||document.querySelector('#reader-chapter-text')?.dataset?.lang||''")
audit['steps']['globals']=ev("({lemma:typeof window.readerFrenchLemmaFor,lex:typeof window.readerFrenchLexicalAnalysisFor,proper:typeof window.readerFrenchIsProperWord,knowledge:typeof window.readerFrenchVocabularyKnowledgeFor,glossMode:window.readerGetFrUnknownGlossMode?.()})")
ev("window.readerSetFrUnknownGlossMode?.('unknown'); true")

words=['fumant','raccrocha','était','fumait','puait','parvenait','leva','appeler','fini','former','trouvait','avait','courant','personne']
audit['lemmas']=ev("(()=>{const ws="+json.dumps(words,ensure_ascii=False)+";return Object.fromEntries(ws.map(w=>[w,window.readerFrenchLemmaFor?.(w)||null]))})()")
lex={}
for word in ['fumant','raccrocha','former','pièce','arrêt','mec','courant','poule','fond','foutue','personne']:
    lex[word]=ev(f"(async()=>await window.readerFrenchLexicalAnalysisFor?.({json.dumps(word,ensure_ascii=False)})||null)()")
audit['lexical']=lex

audit['proper_names']=ev("(()=>{const ws=['Treuffais','Buenaventura','Épaulard','Catalan','Longuevache'];return Object.fromEntries(ws.map(w=>[w,{proper:window.readerFrenchIsProperWord?.(w),knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),instances:[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR')).map(e=>({stored:e.dataset.word,text:e.textContent,class:e.className}))}]))})()")

# Exact user-reported regression: first manual Unknown must stay red after a second word.
click_word('fumant'); wait("document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==='fumant'",10); time.sleep(.8)
audit['fumant_panel_before']=ev("({analysis:document.querySelector('#reader-word-analysis')?.innerText||'',lemma:document.querySelector('#reader-word-lemma')?.value||'',pos:document.querySelector('#reader-word-pos')?.value||'',ru:document.querySelector('#reader-word-ru')?.value||'',source:document.querySelector('#reader-fr-knowledge-source')?.textContent||''})")
ev("document.querySelector('#reader-fr-unknown-btn')?.click();true"); time.sleep(1)
audit['fumant_after_unknown']=snapshot_word('fumant')
click_word('pièce'); wait("document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==='pièce'",10)
ev("document.querySelector('#reader-fr-unknown-btn')?.click();true"); time.sleep(1.4)
audit['after_second_unknown']={'fumant':snapshot_word('fumant'),'piece':snapshot_word('pièce')}
state=json.dumps(audit['after_second_unknown']['fumant'],ensure_ascii=False).lower()
if 'unknown' not in state and 'problem' not in state: audit['bugs'].append('manual Unknown on fumant disappeared after marking pièce')

# Real Nada context traps, not synthetic dictionary examples.
for word in ['arrêt','former','raccrocha','mec','courant','poule','fond','foutue']:
    if click_word(word)=='MISSING':
        audit['bugs'].append(f'missing token: {word}'); continue
    try: wait(f"document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==={json.dumps(word.lower())}",6)
    except Exception: pass
    ev("document.querySelector('#reader-fr-unknown-btn')?.click();true")
    time.sleep(.3)
time.sleep(12)
audit['context_words']={w:snapshot_word(w) for w in ['arrêt','former','raccrocha','mec','courant','poule','fond','foutue','Épaulard']}

audit['all_visible_glosses']=ev("(()=>[...document.querySelectorAll('.rw-fr-gloss-wrap')].map(w=>({word:w.querySelector('.reader-word')?.dataset?.word||'',text:w.querySelector('.rw-fr-gloss-text')?.textContent||'',visible:w.dataset.frGlossVisible||'',provider:w.dataset.frContextProvider||''})).filter(x=>x.text))()")
audit['layout']=ev("(()=>{const gs=[...document.querySelectorAll('.rw-fr-gloss-text')].filter(e=>getComputedStyle(e).display!=='none');let overlaps=[];for(let i=0;i<gs.length;i++){const a=gs[i].getBoundingClientRect();for(let j=i+1;j<gs.length;j++){const b=gs[j].getBoundingClientRect();const x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(x>2&&y>2)overlaps.push({a:gs[i].textContent,b:gs[j].textContent,x,y})}}return {visibleGlosses:gs.length,overlaps:overlaps.slice(0,40)}})()")
for item in audit['all_visible_glosses']:
    if '[' in item.get('text','') or ']' in item.get('text',''): audit['bugs'].append('broken bracket gloss: '+json.dumps(item,ensure_ascii=False))
OUT.joinpath('audit-v4.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(audit,ensure_ascii=False,indent=2))
ws.close()

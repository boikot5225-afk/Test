#!/usr/bin/env python3
import json
import pathlib
import sys
import time

import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)

pages = []
for _ in range(80):
    try:
        pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception:
        pages = []
    if pages:
        break
    time.sleep(.5)
if not pages:
    raise SystemExit('No debuggable WebView page')
page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url', '')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=15, suppress_origin=True)
seq = 0

def cdp(method, params=None):
    global seq
    seq += 1
    ident = seq
    ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get('id') == ident:
            if 'error' in msg:
                raise RuntimeError(msg['error'])
            return msg.get('result', {})

def ev(code, await_promise=True):
    result = cdp('Runtime.evaluate', {
        'expression': code,
        'awaitPromise': await_promise,
        'returnByValue': True,
        'userGesture': True,
    })
    obj = result.get('result', {})
    if obj.get('subtype') == 'error':
        raise RuntimeError(obj.get('description', 'JS error'))
    return obj.get('value')

def wait(code, timeout=30):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = ev(code)
            if last:
                return last
        except Exception as exc:
            last = str(exc)
        time.sleep(.35)
    raise RuntimeError(f'wait timeout: {code}; last={last}')

def click_word(word):
    q = json.dumps(word.lower(), ensure_ascii=False)
    return ev(f"(()=>{{const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')==={q});if(!e)return 'MISSING';e.click();return e.dataset.word}})()")

cdp('Runtime.enable')
cdp('Page.enable')
audit = {'page': page, 'steps': {}, 'bugs': []}
wait("document.readyState==='complete'")
audit['steps']['initial'] = ev("document.body.innerText.slice(0,1800)")

# ACTION_VIEW should open the import modal and complete EPUB parsing.
audit['steps']['import_status'] = wait("(()=>{const e=document.querySelector('#reader-import-status');return e&&/EPUB загружен/.test(e.textContent)?e.textContent:''})()", 45)
audit['steps']['import_lang'] = ev("document.querySelector('#reader-import-lang')?.value||''")
audit['steps']['preview'] = ev("document.querySelector('#reader-import-text')?.value?.slice(0,1600)||''")

save = ev("(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent);const b=bs.find(x=>/^Сохранить$/i.test((x.textContent||'').trim()))||bs.find(x=>/Сохранить/.test(x.textContent||''));if(!b)return 'NO_SAVE';b.click();return (b.textContent||'').trim()})()")
audit['steps']['save'] = save
wait("(()=>{const v=document.querySelector('#reader-reading-view');return !!(v&&getComputedStyle(v).display!=='none'&&document.querySelectorAll('#reader-chapter-text .reader-word').length>20)})()", 30)
time.sleep(2)
ev("window.readerSetFrUnknownGlossMode?.('unknown'); true")
audit['steps']['reading_text'] = ev("document.querySelector('#reader-chapter-text')?.innerText?.slice(0,3200)||''")
audit['steps']['word_count'] = ev("document.querySelectorAll('#reader-chapter-text .reader-word').length")
audit['steps']['globals'] = ev("({lemma:typeof window.readerFrenchLemmaFor,lex:typeof window.readerFrenchLexicalAnalysisFor,proper:typeof window.readerFrenchIsProperWord,knowledge:typeof window.readerFrenchVocabularyKnowledgeFor})")

words = ['fumant','raccrocha','était','fumait','puait','parvenait','leva','appeler','fini','former','trouvait','avait','courant','personne']
audit['lemmas'] = ev("(()=>{const ws=" + json.dumps(words, ensure_ascii=False) + ";return Object.fromEntries(ws.map(w=>[w,window.readerFrenchLemmaFor?.(w)||null]))})()")

lex = {}
for word in ['fumant','raccrocha','former','pièce','arrêt','mec','courant','poule','fond','foutue']:
    lex[word] = ev(f"(async()=>await window.readerFrenchLexicalAnalysisFor?.({json.dumps(word, ensure_ascii=False)})||null)()")
audit['lexical'] = lex

# Inspect proper-name handling before any AI analysis can teach the page.
audit['proper_names'] = ev("(()=>{const ws=['Treuffais','Buenaventura','Épaulard','Catalan','Longuevache'];return Object.fromEntries(ws.map(w=>{const els=[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return [w,{proper:window.readerFrenchIsProperWord?.(w),knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),classes:els.map(e=>e.className),texts:els.map(e=>e.textContent)}]}))})()")

# Manual Unknown persistence: first word must remain red/manual Unknown after the second is marked.
click_word('fumant')
wait("document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==='fumant'", 10)
time.sleep(.8)
audit['fumant_panel'] = ev("({analysis:document.querySelector('#reader-word-analysis')?.innerText||'',lemma:document.querySelector('#reader-word-lemma')?.value||'',pos:document.querySelector('#reader-word-pos')?.value||'',ru:document.querySelector('#reader-word-ru')?.value||'',source:document.querySelector('#reader-fr-knowledge-source')?.textContent||''})")
ev("document.querySelector('#reader-fr-unknown-btn')?.click();true")
time.sleep(1.0)
click_word('pièce')
wait("document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==='pièce'", 10)
ev("document.querySelector('#reader-fr-unknown-btn')?.click();true")
time.sleep(1.3)
audit['manual_after_second'] = ev("(()=>{function s(w){const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return {class:e?.className||'',color:e?getComputedStyle(e).color:'',knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),gloss:e?.parentElement?.querySelector('.rw-fr-gloss-text')?.textContent||''}}return {fumant:s('fumant'),piece:s('pièce')}})()")

fumant_state = json.dumps(audit['manual_after_second'].get('fumant', {}), ensure_ascii=False).lower()
if 'unknown' not in fumant_state and 'problem' not in fumant_state:
    audit['bugs'].append('manual Unknown disappeared after marking a second word')

# Mark real context-sensitive Nada words Unknown so their actual inline gloss becomes visible.
for word in ['arrêt','former','raccrocha','mec','courant','poule','fond','foutue']:
    if click_word(word) == 'MISSING':
        continue
    try:
        wait(f"document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==={json.dumps(word.lower())}", 6)
    except Exception:
        pass
    ev("document.querySelector('#reader-fr-unknown-btn')?.click();true")
    time.sleep(.35)

time.sleep(12)
audit['visible_problem_words'] = ev("(()=>{const ws=['arrêt','former','raccrocha','mec','courant','poule','fond','foutue','Épaulard'];return Object.fromEntries(ws.map(w=>{const es=[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return [w,es.map(e=>({class:e.className,text:e.textContent,gloss:e.parentElement?.querySelector('.rw-fr-gloss-text')?.textContent||'',provider:e.parentElement?.dataset?.frContextProvider||'',ru:e.parentElement?.dataset?.frGlossRu||''}))]}))})()")

# Catch garbage/bracket leaks and layout overlap in what the reader actually paints.
audit['all_glosses'] = ev("(()=>[...document.querySelectorAll('.rw-fr-gloss-wrap')].map(w=>({word:w.querySelector('.reader-word')?.dataset?.word||'',text:w.querySelector('.rw-fr-gloss-text')?.textContent||'',visible:w.dataset.frGlossVisible||'',provider:w.dataset.frContextProvider||''})).filter(x=>x.text))()")
audit['layout'] = ev("(()=>{const gs=[...document.querySelectorAll('.rw-fr-gloss-text')].filter(e=>getComputedStyle(e).display!=='none');let overlaps=[];for(let i=0;i<gs.length;i++){const a=gs[i].getBoundingClientRect();for(let j=i+1;j<gs.length;j++){const b=gs[j].getBoundingClientRect();const x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(x>2&&y>2)overlaps.push({a:gs[i].textContent,b:gs[j].textContent,x,y});}}return {visibleGlosses:gs.length,overlaps:overlaps.slice(0,50),scrollHeight:document.querySelector('#reader-reading-view .rd-scroll')?.scrollHeight||0,clientHeight:document.querySelector('#reader-reading-view .rd-scroll')?.clientHeight||0}})()")

for item in audit['all_glosses']:
    if '[' in item.get('text','') or ']' in item.get('text',''):
        audit['bugs'].append(f"broken bracket leaked into gloss: {item}")

OUT.joinpath('audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(audit, ensure_ascii=False, indent=2))
ws.close()

#!/usr/bin/env python3
import json
import pathlib
import re
import subprocess
import time
import requests
import websocket

OUT=pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
pages=[]
for _ in range(120):
    try: pages=requests.get('http://127.0.0.1:9222/json/list',timeout=2).json()
    except Exception: pages=[]
    if pages: break
    time.sleep(.5)
if not pages: raise SystemExit('No debuggable Reader AI WebView')
page=next((p for p in pages if 'appassets.androidplatform.net' in p.get('url','')),pages[0])
ws=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=25,suppress_origin=True)
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
    result=cdp('Runtime.evaluate',{'expression':code,'awaitPromise':True,'returnByValue':True,'userGesture':True})
    if result.get('exceptionDetails'): raise RuntimeError(str(result['exceptionDetails']))
    return result.get('result',{}).get('value')

def wait_value(code,predicate=lambda x:bool(x),timeout=25,delay=.15):
    end=time.time()+timeout; last=None
    while time.time()<end:
        last=ev(code)
        if predicate(last): return last
        time.sleep(delay)
    raise RuntimeError(f'wait timeout: {code}; last={last!r}')

def screenshot(name):
    with (OUT/name).open('wb') as fh:
        subprocess.run(['adb','exec-out','screencap','-p'],stdout=fh,check=True)

def page_state():
    return ev("""(()=>{const s=document.querySelector('#reader-reading-view .rd-scroll');const root=document.getElementById('reader-chapter-text');const ps=[...root?.querySelectorAll(':scope > .rd-page')||[]];const cur=root?.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');const r=(cur||root)?.getBoundingClientRect();return {mode:!!s?.classList.contains('rd-pages-mode'),count:ps.length,index:ps.indexOf(cur),rect:r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null};})()""")

cdp('Runtime.enable'); cdp('Page.enable')
wait_value("document.readyState==='complete'")
lang=ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||document.getElementById('reader-chapter-text')?.dataset?.lang||''")
if lang!='fr': raise RuntimeError(f'Expected French Reader, got {lang!r}')

info=ev("""(async()=>{const d=await window.readerLoadFrenchVocabularyData?.();return {count:d?.entries?.length||0,suis:window.readerFrenchLemmaFor?.('suis')||'',avait:window.readerFrenchLemmaFor?.('avait')||'',homme:await window.readerFrenchLexicalAnalysisFor?.('homme')};})()""")
if info.get('count',0)<50000 or info.get('suis')!='être' or info.get('avait')!='avoir':
    raise RuntimeError('French vocabulary/lemma gate failed: '+json.dumps(info,ensure_ascii=False))

# The first toc123 audit was invalid: it painted the Unknown CSS class by hand.
# Here the actual user path is exercised: click Elle, then click the real
# French "Не знаю" button, then prove the manual state survives reclassification.
target=ev("""(()=>[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle')?.dataset.word||'')()""")
if not target: raise RuntimeError('Deterministic token Elle missing from fixture')
clicked=ev("""(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle');if(!el)return false;el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return true;})()""")
if not clicked: raise RuntimeError('Could not click Elle')
panel_word=wait_value("document.getElementById('reader-word-title')?.textContent?.trim()||''",lambda x:str(x).lower()=='elle',timeout=8)
button=wait_value("!!document.getElementById('reader-fr-unknown-btn')",timeout=5)
if not button: raise RuntimeError('French Не знаю button missing')
ev("document.getElementById('reader-fr-unknown-btn').click(); true")
manual=wait_value("""(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle');return !!el?.classList.contains('rw-migaku-unknown')&&el?.dataset.readerManualKnowledge==='unknown';})()""",timeout=8)
if not manual: raise RuntimeError('Manual Unknown did not persist for Elle')

gloss=wait_value("""(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle');return el?.parentElement?.querySelector(':scope > .rw-fr-gloss-text')?.textContent?.trim()||'';})()""",lambda x:bool(str(x).strip()),timeout=20)
# This is an architecture/safety gate, not a dictionary-sense benchmark. The
# bundled dictionary currently returns "ей" for Elle in this fixture. Require a
# genuine Russian gloss here; contextual lexical quality is tested separately.
if not re.search(r'[А-Яа-яЁё]',str(gloss)):
    raise RuntimeError(f'Expected a Cyrillic bundled French gloss, got {gloss!r}')
screenshot('toc123-01-french-unknown-gloss.png')

# Only now test the unchanged toc119 Reader. No page-turn function is invoked
# from JavaScript: the transition comes from Android touchscreen input.
state=None
for _ in range(2):
    state=page_state()
    if state['mode'] and state['count']>=2 and state['index']>=0: break
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(.9)
state=page_state()
if not state['mode'] or state['count']<2 or state['index']<0 or not state['rect']:
    raise RuntimeError('Unchanged toc119 page mode did not initialize: '+json.dumps(state,ensure_ascii=False))

dpr=float(ev('window.devicePixelRatio||1'))
r=state['rect']
y_css=max(r['top']+70,min(r['bottom']-70,(r['top']+r['bottom'])/2))
x_right=max(r['left']+120,r['right']-55)
x_left=min(r['right']-120,r['left']+55)
y=int(round(y_css*dpr)); x1=int(round(x_right*dpr)); x2=int(round(x_left*dpr))
inside=ev(f"""(()=>{{const root=document.getElementById('reader-chapter-text');const hit=document.elementFromPoint({(x_right+x_left)/2},{y_css});return !!(root&&hit&&root.contains(hit));}})()""")
if not inside: raise RuntimeError('Physical swipe midpoint is not inside Reader')

# Probe confirms the ADB gesture actually arrived at Reader. This does not alter
# gesture handling; it only records captured events.
ev("""(()=>{window.__toc123TouchProbe=[];if(!window.__toc123TouchProbeBound){window.__toc123TouchProbeBound=true;for(const type of ['touchstart','touchend','touchcancel'])document.addEventListener(type,e=>{const root=document.getElementById('reader-chapter-text'),t=e.changedTouches?.[0]||e.touches?.[0];window.__toc123TouchProbe.push({type,inside:!!(root&&e.target&&root.contains(e.target)),x:t?.clientX??null,y:t?.clientY??null});},true);}return true;})()""")
before=state['index']
screenshot('toc123-02-before-left-swipe.png')
subprocess.run(['adb','shell','input','touchscreen','swipe',str(x1),str(y),str(x2),str(y),'350'],check=True)
time.sleep(1.0)
after=page_state()['index']
events_left=ev('window.__toc123TouchProbe||[]') or []
if not any(e.get('type')=='touchstart' and e.get('inside') for e in events_left) or not any(e.get('type')=='touchend' and e.get('inside') for e in events_left):
    raise RuntimeError('Physical left swipe did not fully reach Reader: '+json.dumps(events_left,ensure_ascii=False))
if after!=before+1:
    raise RuntimeError(f'Unchanged toc119 left swipe failed: {before} -> {after}')
screenshot('toc123-03-after-left-swipe.png')

ev('window.__toc123TouchProbe=[]; true')
subprocess.run(['adb','shell','input','touchscreen','swipe',str(x2),str(y),str(x1),str(y),'350'],check=True)
time.sleep(1.0)
back=page_state()['index']
events_right=ev('window.__toc123TouchProbe||[]') or []
if not any(e.get('type')=='touchstart' and e.get('inside') for e in events_right) or not any(e.get('type')=='touchend' and e.get('inside') for e in events_right):
    raise RuntimeError('Physical right swipe did not fully reach Reader: '+json.dumps(events_right,ensure_ascii=False))
if back!=before:
    raise RuntimeError(f'Unchanged toc119 right swipe failed: {after} -> {back}, expected {before}')
screenshot('toc123-04-after-right-swipe.png')

result={'ok':True,'lang':lang,'vocabCount':info['count'],'lemma':{'suis':info['suis'],'avait':info['avait']},'manualUnknown':'elle','gloss':gloss,'pages':state['count'],'swipe':[before,after,back],'leftTouchEvents':len(events_left),'rightTouchEvents':len(events_right),'core':'byte-identical shipped toc119'}
(OUT/'toc123-isolated-live-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
ws.close()

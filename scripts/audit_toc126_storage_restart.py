#!/usr/bin/env python3
import json
import pathlib
import time
import requests
import websocket

OUT = pathlib.Path('runtime-audit')
pages=[]
for _ in range(140):
    try: pages=requests.get('http://127.0.0.1:9222/json/list',timeout=2).json()
    except Exception: pages=[]
    if pages: break
    time.sleep(.35)
if not pages: raise SystemExit('No debuggable Reader AI WebView after restart')
page=next((p for p in pages if 'appassets.androidplatform.net' in p.get('url','')),pages[0])
ws=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=30,suppress_origin=True)
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

def wait(code,timeout=45):
    end=time.time()+timeout; last=None
    while time.time()<end:
        last=ev(code)
        if last: return last
        time.sleep(.3)
    raise RuntimeError(f'timeout: {code}; last={last!r}')

cdp('Runtime.enable')
wait("document.readyState==='complete'")
if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked=ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked: raise RuntimeError('Guest button not found after restart')
wait("document.getElementById('main-app')?.style.display!=='none'",20)

state=ev(r"""(async()=>{
  window.showScreen?.('reader');
  await window.renderReaderScreen?.();
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const imported=books.find(b=>b?.title==='Audit mémoire toc126');
  const raw=localStorage.getItem(key)||'';
  return {key,id:imported?.id||'',paragraph:Number(imported?.currentParagraph||0),chapters:imported?.chapters?.length||0,localBytes:new Blob([raw]).size,localHasChapters:/\"chapters\"/.test(raw),count:books.length};
})()""")
if not state or not state['id'] or state['chapters'] != 12 or state['paragraph'] < 1:
    raise RuntimeError('book/position did not survive process restart: '+repr(state))
if state['localBytes'] > 50_000 or state['localHasChapters']:
    raise RuntimeError('localStorage grew back into a full book snapshot after restart: '+repr(state))

book_id=json.dumps(state['id'])
ev(f"window.readerOpenBook?.({book_id}); true")
wait("document.querySelectorAll('#reader-chapter-text .reader-word').length>20",30)
opened=ev("(()=>({title:String(document.getElementById('reader-book-title')?.textContent||''),p:Number(document.getElementById('reader-chapter-text')?.dataset?.activeParagraph||document.querySelector('#reader-chapter-text .reader-paragraph.active')?.dataset?.p||0)}))()")
if 'Audit mémoire toc126' not in opened.get('title',''):
    raise RuntimeError('durable book could not be reopened after restart: '+repr(opened))

# Deletion must update per-book IDB records and the small local index without
# resurrecting the old full snapshot.
ev("window.confirm=()=>true; true")
ev(f"window.readerDeleteBook?.({book_id}); true")
time.sleep(2.0)
after=ev(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const raw=localStorage.getItem(key)||'';
  return {count:books.length,hasImported:books.some(b=>b?.title==='Audit mémoire toc126'),hasLegacy:books.some(b=>b?.id==='legacy_seed_toc126'),localBytes:new Blob([raw]).size,localHasChapters:/\"chapters\"/.test(raw)};
})()""")
if after['hasImported'] or not after['hasLegacy']:
    raise RuntimeError('per-book delete failed or removed unrelated book: '+repr(after))
if after['localBytes'] > 50_000 or after['localHasChapters']:
    raise RuntimeError('delete re-expanded localStorage: '+repr(after))

result={'ok':True,'beforeRestart':state,'opened':opened,'afterDelete':after}
(OUT/'toc126-storage-restart.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
ws.close()

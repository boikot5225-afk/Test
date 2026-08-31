#!/usr/bin/env python3
import json
import time
import requests
import websocket

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

def wait(code,timeout=40):
    end=time.time()+timeout; last=None
    while time.time()<end:
        try:
            last=ev(code)
            if last: return last
        except Exception as exc: last=str(exc)
        time.sleep(.35)
    raise RuntimeError(f'wait timeout: {code}; last={last}')

cdp('Runtime.enable'); cdp('Page.enable')
wait("document.readyState==='complete'",30)
if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked=ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked: raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'",20)
reading_ready="(()=>{const v=document.querySelector('#reader-reading-view'),root=document.querySelector('#reader-chapter-text'),r=root?.getBoundingClientRect();return !!(v&&getComputedStyle(v).display!=='none'&&root&&root.querySelectorAll('.reader-word').length>30&&r&&r.width>120&&r.height>120)})()"
end=time.time()+35
while time.time()<end and not ev(reading_ready):
    status=ev("document.querySelector('#reader-import-status')?.textContent||''") or ''
    if 'EPUB загружен' in status:
        ev("(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent);const b=bs.find(x=>/^Сохранить$/i.test((x.textContent||'').trim()))||bs.find(x=>/Сохранить/.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    time.sleep(.5)
wait(reading_ready,20)
lang=ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||document.getElementById('reader-chapter-text')?.dataset?.lang||''")
if lang!='fr': raise RuntimeError(f'Opened reader is not French: {lang!r}')
print(json.dumps({'ok':True,'lang':lang,'words':ev("document.querySelectorAll('#reader-chapter-text .reader-word').length")},ensure_ascii=False))
ws.close()

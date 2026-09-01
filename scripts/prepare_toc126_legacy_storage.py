#!/usr/bin/env python3
import json
import time
import requests
import websocket

pages = []
for _ in range(120):
    try:
        pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception:
        pages = []
    if pages:
        break
    time.sleep(.35)
if not pages:
    raise SystemExit('No debuggable Reader AI WebView')
page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url', '')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=25, suppress_origin=True)
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

def ev(code):
    result = cdp('Runtime.evaluate', {
        'expression': code,
        'awaitPromise': True,
        'returnByValue': True,
        'userGesture': True,
    })
    if result.get('exceptionDetails'):
        raise RuntimeError(str(result['exceptionDetails']))
    return result.get('result', {}).get('value')

def wait(code, timeout=30):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = ev(code)
        if last:
            return last
        time.sleep(.25)
    raise RuntimeError(f'timeout: {code}; last={last!r}')

cdp('Runtime.enable')
wait("document.readyState==='complete'")
if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = ev(r"""(()=>{
  const key = window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1::guest';
  const huge = ('ancien texte français pour migration. ').repeat(72000);
  const now = new Date(Date.now()-86400000).toISOString();
  const legacy = [{
    id:'legacy_seed_toc126', title:'Legacy seed toc126', author:'Reader AI',
    lang:'fr', sourceLang:'fr', format:'text', source:'legacy-test',
    importKey:'legacy-seed-toc126', createdAt:now, updatedAt:now,
    currentChapter:0, currentParagraph:0,
    chapters:[{id:'ch_0',title:'Ancienne bibliothèque',paragraphs:[huge]}]
  }];
  localStorage.setItem(key, JSON.stringify(legacy));
  // Storage/migration test only: do not let hundreds of synthetic French words
  // start DeepSeek while we are measuring import behavior and memory.
  localStorage.setItem('an2_reader_vocab_estimate_fr_v1::guest', JSON.stringify({
    language:'fr',version:1,estimate:63548,listLength:63548,
    conservativeKnownCount:63548,updatedAt:new Date().toISOString()
  }));
  const raw=localStorage.getItem(key)||'';
  return {key,bytes:new Blob([raw]).size,hasChapters:/\"chapters\"/.test(raw),guest:localStorage.getItem('an2_guest')};
})()""")
if not result or result.get('bytes', 0) < 1_500_000 or not result.get('hasChapters'):
    raise RuntimeError('legacy full library seed failed: ' + repr(result))
print(json.dumps(result, ensure_ascii=False, indent=2))
ws.close()

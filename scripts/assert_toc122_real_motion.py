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
    time.sleep(.5)
if not pages:
    raise SystemExit('No debuggable Reader AI WebView')

page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url', '')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=25, suppress_origin=True)
seq = 0

def ev(code):
    global seq
    seq += 1
    ident = seq
    ws.send(json.dumps({'id': ident, 'method': 'Runtime.evaluate', 'params': {
        'expression': code,
        'awaitPromise': True,
        'returnByValue': True,
    }}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get('id') == ident:
            if msg.get('error') or msg.get('result', {}).get('exceptionDetails'):
                raise RuntimeError(str(msg))
            return msg.get('result', {}).get('result', {}).get('value')

state = ev("""(()=>{
  const scroller=document.querySelector('#reader-reading-view .rd-scroll');
  const page=document.querySelector('#reader-chapter-text > .rd-page');
  const cs=page?getComputedStyle(page):null;
  return {
    reducedMotion:!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    animation:scroller?.dataset?.rdPageAnimation||'',
    transitionDuration:cs?.transitionDuration||'',
    transitionProperty:cs?.transitionProperty||'',
  };
})()""")
print(json.dumps(state, ensure_ascii=False, indent=2))
if state.get('reducedMotion'):
    raise SystemExit('FAIL: WebView reports prefers-reduced-motion: reduce; real flip animation is bypassed')
ws.close()

#!/usr/bin/env python3
import base64
import json
import pathlib
import subprocess
import time

import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
EPUB = OUT / 'toc103-pagination.epub'

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


def wait(code, timeout=45):
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


def page_state():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const pages=[...root?.querySelectorAll(':scope > .rd-page')||[]];
      const cur=root?.querySelector(':scope > .rd-page.rd-page-current, :scope > .rd-page.rd-page-show');
      const marker=(cur?.innerText||'').match(/PAGE_TURN_MARKER_\\d+/)?.[0]||'';
      const first=cur?.querySelector('.reader-paragraph');
      return {
        pageCount:pages.length,
        currentIndex:pages.indexOf(cur),
        marker,
        paragraphIndex:first?.dataset?.paragraphIndex||first?.dataset?.index||'',
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
        pagesMode:document.querySelector('#reader-reading-view .rd-scroll')?.classList.contains('rd-pages-mode')||false,
      };
    })()""")


cdp('Runtime.enable')
cdp('Page.enable')
wait("document.readyState==='complete'", 30)

# Enter supported guest mode on a clean install.
if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = wait("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()", 60)
    if not clicked:
        raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'", 30)
wait("typeof window.readerImportFromFile==='function' && typeof window.saveReaderImport==='function'", 30)

# Import a deterministic EPUB through Reader AI's real EPUB parser. The test is
# about navigation, so the host passes the bytes to the existing file-import API
# instead of depending on Android's picker UI.
b64 = base64.b64encode(EPUB.read_bytes()).decode('ascii')
expr = f"""(async()=>{{
  window.showReaderImportModal?.();
  const bytes=Uint8Array.from(atob({json.dumps(b64)}),c=>c.charCodeAt(0));
  const file=new File([bytes],'toc103-pagination.epub',{{type:'application/epub+zip'}});
  await window.readerImportFromFile({{target:{{files:[file]}}}});
  return document.getElementById('reader-import-status')?.textContent||'';
}})()"""
status = ev(expr) or ''
if 'EPUB' not in status:
    raise RuntimeError('EPUB parser did not accept fixture: ' + status)
ev("(()=>{const t=document.getElementById('reader-import-title');if(t)t.value='Pagination Acceptance';return window.saveReaderImport?.()})()")

wait("(()=>{const v=document.getElementById('reader-reading-view');return !!(v&&getComputedStyle(v).display!=='none'&&document.querySelectorAll('#reader-chapter-text .reader-paragraph').length>=10)})()", 45)
time.sleep(1.5)

# Force the real page mode through the same public UI function and disable only
# animation timing, not navigation itself.
if not ev("document.querySelector('#reader-reading-view .rd-scroll')?.classList.contains('rd-pages-mode')"):
    ev("window.readerTogglePagesMode(); true")
ev("window.rdSetPageAnimation?.('none', null); true")
wait("document.querySelectorAll('#reader-chapter-text > .rd-page').length>=2", 20)
wait("document.getElementById('reader-chapter-text')?.dataset?.boundReaderSwipe==='1'", 10)

before = page_state()
if before['pageCount'] < 2 or before['currentIndex'] < 0 or not before['marker']:
    raise RuntimeError('Pagination did not produce navigable pages: ' + json.dumps(before, ensure_ascii=False))

# This is the acceptance condition the broken toc122 never had: inject a real
# Android touch swipe, not a direct JS call to readerNextParagraph().
subprocess.run(['adb','shell','input','swipe','900','1150','180','1150','320'], check=True)
time.sleep(1.2)
after_next = page_state()
if after_next['currentIndex'] <= before['currentIndex'] or after_next['marker'] == before['marker']:
    raise RuntimeError('PHYSICAL SWIPE DID NOT TURN PAGE: ' + json.dumps({'before': before, 'after': after_next}, ensure_ascii=False))

subprocess.run(['adb','shell','input','swipe','180','1150','900','1150','320'], check=True)
time.sleep(1.2)
after_prev = page_state()
if after_prev['currentIndex'] != before['currentIndex'] or after_prev['marker'] != before['marker']:
    raise RuntimeError('REVERSE PHYSICAL SWIPE DID NOT RETURN PAGE: ' + json.dumps({'before': before, 'after': after_prev}, ensure_ascii=False))

result = {
    'ok': True,
    'fixture': str(EPUB),
    'before': before,
    'after_next': after_next,
    'after_prev': after_prev,
    'assertions': ['page mode has >=2 pages', 'Android left swipe advances', 'Android right swipe returns'],
}
(OUT / 'pagination-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))

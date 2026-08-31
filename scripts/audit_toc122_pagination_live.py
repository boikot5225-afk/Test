#!/usr/bin/env python3
import json
import pathlib
import subprocess
import time

import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)

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
        time.sleep(.3)
    raise RuntimeError(f'wait timeout: {code}; last={last}')


def save_screen(name):
    with (OUT / name).open('wb') as fh:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=fh, check=True)


def page_state():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const direct=[...root?.querySelectorAll(':scope > .rd-page')||[]];
      let cur=root?.querySelector(':scope > .rd-page.rd-page-current');
      if(!cur) cur=root?.querySelector(':scope > .rd-page.rd-page-show');
      const first=cur?.querySelector('.reader-paragraph');
      const rect=cur?.getBoundingClientRect();
      return {
        lang:document.getElementById('reader-reading-view')?.dataset?.readerLang||root?.dataset?.lang||'',
        pagesMode:!!document.querySelector('#reader-reading-view .rd-scroll')?.classList.contains('rd-pages-mode'),
        pageCount:direct.length,
        currentIndex:direct.indexOf(cur),
        paragraphIndex:first?.dataset?.p||first?.dataset?.paragraphIndex||'',
        text:(cur?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,160),
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
        rect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}:null,
      };
    })()""")


def install_probe():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const surface=root?.querySelector(':scope > .rd-page.rd-page-current, :scope > .rd-page.rd-page-show')||root;
      const rect=surface?.getBoundingClientRect();
      const dpr=window.devicePixelRatio||1;
      window.__toc122SwipeProbe=[];
      if(!window.__toc122SwipeProbeInstalled){
        window.__toc122SwipeProbeInstalled=true;
        for(const type of ['touchstart','touchmove','touchend','touchcancel']){
          document.addEventListener(type,(event)=>{
            const t=event.touches?.[0]||event.changedTouches?.[0]||null;
            const liveRoot=document.getElementById('reader-chapter-text');
            if(window.__toc122SwipeProbe.length<80){
              window.__toc122SwipeProbe.push({
                type,
                x:t?.clientX??null,
                y:t?.clientY??null,
                insideRoot:!!(liveRoot&&event.target&&liveRoot.contains(event.target)),
                target:event.target?.className||event.target?.id||event.target?.tagName||'',
                at:Date.now(),
              });
            }
          },true);
        }
      }
      if(!rect||rect.width<120||rect.height<120) return {ok:false,rect};
      const y=Math.max(rect.top+60,Math.min(rect.bottom-60,window.innerHeight*0.50));
      const right=Math.max(rect.left+100,Math.min(rect.right-45,window.innerWidth-45));
      const left=Math.min(rect.right-100,Math.max(rect.left+45,45));
      const hit=document.elementFromPoint((right+left)/2,y);
      return {
        ok:true,
        dpr,
        rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},
        midpointInsideRoot:!!(root&&hit&&root.contains(hit)),
        midpointHit:hit?.className||hit?.id||hit?.tagName||'',
        leftSwipe:{x1:Math.round(right*dpr),y1:Math.round(y*dpr),x2:Math.round(left*dpr),y2:Math.round(y*dpr)},
        rightSwipe:{x1:Math.round(left*dpr),y1:Math.round(y*dpr),x2:Math.round(right*dpr),y2:Math.round(y*dpr)},
      };
    })()""")


def events():
    return ev("window.__toc122SwipeProbe||[]") or []


def physical_swipe(coords):
    subprocess.run([
        'adb','shell','input','touchscreen','swipe',
        str(coords['x1']),str(coords['y1']),str(coords['x2']),str(coords['y2']),'320'
    ], check=True)


cdp('Runtime.enable')
cdp('Page.enable')
wait("document.readyState==='complete'")
wait("""(()=>{
  const v=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  const r=root?.getBoundingClientRect();
  return !!(v&&getComputedStyle(v).display!=='none'&&root&&root.querySelectorAll('.reader-paragraph').length>=10&&r&&r.width>120&&r.height>120);
})()""", 40)

lang = ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||document.getElementById('reader-chapter-text')?.dataset?.lang||''")
if lang != 'fr':
    raise RuntimeError(f'Pagination acceptance is not on French reader: {lang!r}')

# Keep this acceptance deterministic: page movement itself is under test, not CSS animation timing.
ev("window.rdSetPageAnimation?.('none', null); true")

# Use the production public toggle. Do not construct rd-page wrappers from the test.
for _ in range(2):
    state = page_state()
    if state['pagesMode'] and state['pageCount'] >= 2 and state['currentIndex'] >= 0:
        break
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(1.0)

wait("document.getElementById('reader-chapter-text')?.dataset?.boundReaderSwipe==='1'", 10)
before = page_state()
if not before['pagesMode'] or before['pageCount'] < 2 or before['currentIndex'] < 0:
    raise RuntimeError('French page mode did not produce >=2 real pages: ' + json.dumps(before, ensure_ascii=False))

probe = install_probe()
(OUT / 'toc122-swipe-environment.json').write_text(json.dumps(probe, ensure_ascii=False, indent=2), encoding='utf-8')
if not probe.get('ok') or not probe.get('midpointInsideRoot'):
    raise RuntimeError('Physical swipe target is not the visible French page: ' + json.dumps(probe, ensure_ascii=False))

save_screen('02-fr-before-left-swipe.png')
physical_swipe(probe['leftSwipe'])
time.sleep(1.0)
after_next = page_state()
left_events = events()
(OUT / 'toc122-left-swipe-events.json').write_text(json.dumps(left_events, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('03-fr-after-left-swipe.png')

if not any(e.get('type') == 'touchstart' and e.get('insideRoot') for e in left_events):
    raise RuntimeError('Android left swipe never reached French reader root')
if not any(e.get('type') == 'touchend' and e.get('insideRoot') for e in left_events):
    raise RuntimeError('Android left swipe did not complete in French reader root')
if after_next['currentIndex'] != before['currentIndex'] + 1:
    raise RuntimeError('Physical left swipe did not advance exactly one French page: ' + json.dumps({'before':before,'after':after_next}, ensure_ascii=False))

ev("window.__toc122SwipeProbe=[]; true")
physical_swipe(probe['rightSwipe'])
time.sleep(1.0)
after_prev = page_state()
right_events = events()
(OUT / 'toc122-right-swipe-events.json').write_text(json.dumps(right_events, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('04-fr-after-right-swipe.png')

if not any(e.get('type') == 'touchstart' and e.get('insideRoot') for e in right_events):
    raise RuntimeError('Android right swipe never reached French reader root')
if not any(e.get('type') == 'touchend' and e.get('insideRoot') for e in right_events):
    raise RuntimeError('Android right swipe did not complete in French reader root')
if after_prev['currentIndex'] != before['currentIndex']:
    raise RuntimeError('Physical right swipe did not return to the original French page: ' + json.dumps({'before':before,'after':after_prev}, ensure_ascii=False))

result = {
    'ok': True,
    'before': before,
    'after_next': after_next,
    'after_prev': after_prev,
    'assertions': [
        'Visible reader language is French',
        'Physical Android left swipe reaches Reader root and advances exactly one page',
        'Physical Android right swipe reaches Reader root and returns exactly one page',
    ],
}
(OUT / 'toc122-pagination-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))

# Restore scroll mode so the existing lexical/layout audit observes the same state as before.
if page_state()['pagesMode']:
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(.5)
ws.close()

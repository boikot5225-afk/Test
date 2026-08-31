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
      const scroller=document.querySelector('#reader-reading-view .rd-scroll');
      return {
        lang:document.getElementById('reader-reading-view')?.dataset?.readerLang||root?.dataset?.lang||'',
        pagesMode:!!scroller?.classList.contains('rd-pages-mode'),
        animation:scroller?.dataset?.rdPageAnimation||'',
        pageCount:direct.length,
        currentIndex:direct.indexOf(cur),
        paragraphIndex:first?.dataset?.p||first?.dataset?.paragraphIndex||'',
        text:(cur?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,160),
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
        ranging:!!window.__readerRanging,
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
            if(window.__toc122SwipeProbe.length<120){
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


def physical_swipe(coords, duration_ms):
    subprocess.run([
        'adb','shell','input','touchscreen','swipe',
        str(coords['x1']),str(coords['y1']),str(coords['x2']),str(coords['y2']),str(duration_ms)
    ], check=True)


def clear_probe():
    ev("window.__toc122SwipeProbe=[]; true")


def assert_touch_complete(label, event_list):
    if not any(e.get('type') == 'touchstart' and e.get('insideRoot') for e in event_list):
        raise RuntimeError(f'{label}: touchstart never reached Reader root')
    if not any(e.get('type') == 'touchend' and e.get('insideRoot') for e in event_list):
        raise RuntimeError(f'{label}: touchend never completed in Reader root')


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

# Production page mode and production flip animation. The old acceptance test
# forced animation=none and therefore skipped the exact race a real user sees.
for _ in range(2):
    state = page_state()
    if state['pagesMode'] and state['pageCount'] >= 2 and state['currentIndex'] >= 0:
        break
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(1.0)
ev("window.rdSetPageAnimation?.('flip', null); true")
time.sleep(.4)

wait("document.getElementById('reader-chapter-text')?.dataset?.boundReaderSwipe==='1'", 10)
before = page_state()
if not before['pagesMode'] or before['pageCount'] < 2 or before['currentIndex'] < 0:
    raise RuntimeError('French page mode did not produce >=2 real pages: ' + json.dumps(before, ensure_ascii=False))
if before['animation'] != 'flip':
    raise RuntimeError('Production flip animation is not active: ' + json.dumps(before, ensure_ascii=False))

probe = install_probe()
(OUT / 'toc122-swipe-environment.json').write_text(json.dumps(probe, ensure_ascii=False, indent=2), encoding='utf-8')
if not probe.get('ok') or not probe.get('midpointInsideRoot'):
    raise RuntimeError('Physical swipe target is not the visible French page: ' + json.dumps(probe, ensure_ascii=False))

# 1) Human-speed swipe while a stale selection/ranging flag is deliberately set.
# Old production code discarded this touchend entirely; the old 320ms CI swipe
# never exercised the human-duration or stale-ranging failure.
ev("window.__readerRanging=true; true")
save_screen('02-fr-before-human-left-swipe.png')
physical_swipe(probe['leftSwipe'], 950)
time.sleep(1.0)
after_human_next = page_state()
human_left_events = events()
(OUT / 'toc122-human-left-swipe-events.json').write_text(json.dumps(human_left_events, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('03-fr-after-human-left-swipe.png')
assert_touch_complete('human left swipe', human_left_events)
if after_human_next['currentIndex'] != before['currentIndex'] + 1:
    raise RuntimeError('Human-speed left swipe did not advance exactly one page: ' + json.dumps({'before':before,'after':after_human_next}, ensure_ascii=False))

clear_probe()
physical_swipe(probe['rightSwipe'], 950)
time.sleep(1.0)
after_human_prev = page_state()
human_right_events = events()
assert_touch_complete('human right swipe', human_right_events)
if after_human_prev['currentIndex'] != before['currentIndex']:
    raise RuntimeError('Human-speed right swipe did not return exactly one page: ' + json.dumps({'before':before,'after':after_human_prev}, ensure_ascii=False))

# 2) Reproduce the real French-reader race: start a normal animated turn, then
# rebuild the same chapter before the 620ms flip finishes. Background lexical /
# context work can do exactly this. The user's page-turn decision must survive.
clear_probe()
race_before = page_state()
race_para = int(race_before['paragraphIndex'] or 0)
physical_swipe(probe['leftSwipe'], 320)
ev(f"window.readerSelectParagraph?.({race_para}); true")
time.sleep(1.3)
race_after = page_state()
race_events = events()
(OUT / 'toc122-rerender-race-events.json').write_text(json.dumps(race_events, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('04-fr-after-rerender-race.png')
assert_touch_complete('rerender-race left swipe', race_events)
if race_after['currentIndex'] != race_before['currentIndex'] + 1:
    raise RuntimeError('Same-chapter rerender cancelled the animated page turn: ' + json.dumps({'before':race_before,'after':race_after}, ensure_ascii=False))

clear_probe()
physical_swipe(probe['rightSwipe'], 800)
time.sleep(1.0)
race_return = page_state()
if race_return['currentIndex'] != before['currentIndex']:
    raise RuntimeError('Reader did not recover after rerender race: ' + json.dumps({'expected':before,'after':race_return}, ensure_ascii=False))

# 3) Repeated human swipes: no latent animating/ranging freeze after recovery.
cycles = []
for cycle in range(3):
    clear_probe()
    start = page_state()
    physical_swipe(probe['leftSwipe'], 700)
    time.sleep(.9)
    nxt = page_state()
    if nxt['currentIndex'] != start['currentIndex'] + 1:
        raise RuntimeError(f'cycle {cycle+1}: left turn froze: ' + json.dumps({'before':start,'after':nxt}, ensure_ascii=False))
    physical_swipe(probe['rightSwipe'], 700)
    time.sleep(.9)
    back = page_state()
    if back['currentIndex'] != start['currentIndex']:
        raise RuntimeError(f'cycle {cycle+1}: right turn froze: ' + json.dumps({'before':start,'after':back}, ensure_ascii=False))
    cycles.append({'before':start,'after_left':nxt,'after_right':back})

save_screen('05-fr-after-page-turn-stress.png')
result = {
    'ok': True,
    'before': before,
    'after_human_next': after_human_next,
    'after_human_prev': after_human_prev,
    'race_before': race_before,
    'race_after': race_after,
    'race_return': race_return,
    'cycles': cycles,
    'assertions': [
        'Visible reader language is French',
        'Production flip animation is enabled',
        '950ms physical swipe works even with stale __readerRanging',
        'Same-chapter rerender during flip cannot cancel the page turn',
        'Three repeated left/right human-speed cycles do not freeze',
    ],
}
(OUT / 'toc122-pagination-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))

if page_state()['pagesMode']:
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(.5)
ws.close()

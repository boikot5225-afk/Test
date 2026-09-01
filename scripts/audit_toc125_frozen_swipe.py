#!/usr/bin/env python3
import json
import pathlib
import re
import subprocess
import time
import xml.etree.ElementTree as ET
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
    time.sleep(.3)
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

def screenshot(name):
    with (OUT / name).open('wb') as fh:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=fh, check=True)

def adb_ui_xml():
    remote = '/sdcard/toc125-window.xml'
    subprocess.run(['adb', 'shell', 'uiautomator', 'dump', remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return subprocess.run(['adb', 'shell', 'cat', remote], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False).stdout or ''

def has_anr(xml=None):
    xml = adb_ui_xml() if xml is None else xml
    return bool(re.search(r"(?:isn't|is not|not)\s+responding|quickstep", xml, re.I))

def dismiss_anr():
    dismissed = False
    for _ in range(5):
        xml = adb_ui_xml()
        if not has_anr(xml):
            return dismissed
        try:
            root = ET.fromstring(xml)
        except Exception:
            root = None
        tapped = False
        if root is not None:
            for node in root.iter('node'):
                if str(node.attrib.get('text', '')).strip().lower() != 'wait':
                    continue
                match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.attrib.get('bounds', ''))
                if not match:
                    continue
                x1, y1, x2, y2 = map(int, match.groups())
                subprocess.run(['adb', 'shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)], check=False)
                tapped = True
                break
        if not tapped:
            subprocess.run(['adb', 'shell', 'input', 'keyevent', '4'], check=False)
        dismissed = True
        time.sleep(.7)
    return dismissed

def state():
    return ev("""(()=>{
      const s=document.querySelector('#reader-reading-view .rd-scroll');
      const root=document.getElementById('reader-chapter-text');
      const ps=[...root?.querySelectorAll(':scope > .rd-page')||[]];
      const cur=root?.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');
      const r=(cur||root)?.getBoundingClientRect();
      const modal=document.getElementById('reader-import-modal');
      return {
        mode:!!s?.classList.contains('rd-pages-mode'),
        count:ps.length,
        index:ps.indexOf(cur),
        rect:r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:null,
        ranging:!!window.__readerRanging,
        swipeBound:root?.dataset?.boundReaderSwipe||'',
        delegationBound:root?.dataset?.boundReaderDelegation||'',
        importModalVisible:!!(modal&&getComputedStyle(modal).display!=='none'&&modal.getBoundingClientRect().width>0&&modal.getBoundingClientRect().height>0),
        canonicalModule:String(globalThis.__readerCanonicalModuleUrl||''),
      };
    })()""")

def write_debug(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def wait_ranging_clear(timeout=4.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not bool(ev('!!window.__readerRanging')):
            return True
        time.sleep(.15)
    return False

cdp('Runtime.enable')
if ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||''") != 'fr':
    raise RuntimeError('swipe gate is not in French Reader')

# Remove only UI overlays owned by Reader itself; this does not touch reader state,
# pagination code or gesture handlers.
ev("window.readerCloseWordPanel?.(); window.closeReaderImportModal?.(); true")
ev("window.readerSelectParagraph?.(0); true")
time.sleep(.8)
dismissed = dismiss_anr()
if has_anr():
    screenshot('toc125-swipe-anr-stuck.png')
    raise RuntimeError('Android system ANR overlay remained before swipe gate')
if not wait_ranging_clear():
    diag = {'phase': 'setup', 'state': state(), 'ui': adb_ui_xml()[:5000]}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-ranging-stuck.png')
    raise RuntimeError('reader ranging guard remained active before swipe')

for _ in range(2):
    s = state()
    if s['mode'] and s['count'] >= 2 and s['index'] >= 0:
        break
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(1.0)
s = state()
if not s['mode'] or s['count'] < 2 or s['index'] < 0 or not s['rect']:
    raise RuntimeError('frozen toc119 page mode unavailable: ' + json.dumps(s))
if s['index'] >= s['count'] - 1:
    ev("window.readerSelectParagraph?.(0); true")
    time.sleep(.8)
    s = state()
if s['importModalVisible']:
    raise RuntimeError('Reader import modal is still visible before swipe')
if s['swipeBound'] != '1':
    raise RuntimeError('frozen swipe listener is not bound to chapter root: ' + json.dumps(s))

# Observe only. The listeners below never cancel, mutate or replace Reader events.
ev("""(()=>{
  window.__toc125Touch=[];
  window.__toc125PageChanges=[];
  if(!window.__toc125TouchBound){
    window.__toc125TouchBound=true;
    for(const type of ['touchstart','touchmove','touchend','touchcancel']){
      document.addEventListener(type,e=>{
        const root=document.getElementById('reader-chapter-text');
        const t=e.touches?.[0]||e.changedTouches?.[0]||null;
        window.__toc125Touch.push({
          type,
          inside:!!(root&&e.target&&root.contains(e.target)),
          x:t?.clientX??null,
          y:t?.clientY??null,
          ranging:!!window.__readerRanging,
          at:Math.round(performance.now()),
        });
      },true);
    }
    window.addEventListener('reader:pagechange',e=>window.__toc125PageChanges.push({
      pageIndex:Number(e.detail?.pageIndex??-1),
      pageCount:Number(e.detail?.pageCount??-1),
      at:Math.round(performance.now()),
    }));
  }
  return true;
})()""")

# First prove the frozen page-navigation handler itself works. If this fails,
# there is no point blaming ADB touch injection.
before_direct = state()
ev('window.readerNextParagraph?.(); true')
time.sleep(1.15)
after_direct = state()
if after_direct['index'] != before_direct['index'] + 1:
    diag = {'phase': 'direct-next', 'before': before_direct, 'after': after_direct, 'pageChanges': ev('window.__toc125PageChanges||[]') or []}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-direct-next-failed.png')
    raise RuntimeError(f"frozen toc119 direct next failed: {before_direct['index']}->{after_direct['index']}")
ev('window.readerPrevParagraph?.(); true')
time.sleep(1.15)
after_direct_back = state()
if after_direct_back['index'] != before_direct['index']:
    diag = {'phase': 'direct-prev', 'before': before_direct, 'afterNext': after_direct, 'afterBack': after_direct_back, 'pageChanges': ev('window.__toc125PageChanges||[]') or []}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-direct-prev-failed.png')
    raise RuntimeError(f"frozen toc119 direct prev failed: {after_direct['index']}->{after_direct_back['index']}")

if not wait_ranging_clear():
    raise RuntimeError('reader ranging guard remained active after direct navigation preflight')
dismissed = dismiss_anr() or dismissed
if has_anr():
    screenshot('toc125-swipe-anr-before-gesture.png')
    raise RuntimeError('Android system ANR overlay returned before physical swipe')

s = state()
dpr = float(ev('window.devicePixelRatio||1'))
r = s['rect']
ycss = max(r['top'] + 70, min(r['bottom'] - 70, (r['top'] + r['bottom']) / 2))
xr = max(r['left'] + 120, r['right'] - 55)
xl = min(r['right'] - 120, r['left'] + 55)
inside = ev(f"""(()=>{{
  const root=document.getElementById('reader-chapter-text');
  return [[{xr},{ycss}],[{(xr+xl)/2},{ycss}],[{xl},{ycss}]].every(([x,y])=>{{
    const hit=document.elementFromPoint(x,y);
    return !!(root&&hit&&root.contains(hit));
  }});
}})()""")
if not inside:
    dismissed = dismiss_anr() or dismissed
    inside = ev(f"""(()=>{{
      const root=document.getElementById('reader-chapter-text');
      return [[{xr},{ycss}],[{(xr+xl)/2},{ycss}],[{xl},{ycss}]].every(([x,y])=>{{
        const hit=document.elementFromPoint(x,y);
        return !!(root&&hit&&root.contains(hit));
      }});
    }})()""")
if not inside:
    raise RuntimeError('swipe path is not inside Reader')

x1 = int(round(xr * dpr))
x2 = int(round(xl * dpr))
y = int(round(ycss * dpr))
before = s['index']
ev('window.__toc125Touch=[]; window.__toc125PageChanges=[]; true')
screenshot('toc125-swipe-before-left.png')
subprocess.run(['adb','shell','input','touchscreen','swipe',str(x1),str(y),str(x2),str(y),'350'], check=True)
time.sleep(1.15)
after_state = state()
after = after_state['index']
left = ev('window.__toc125Touch||[]') or []
left_pages = ev('window.__toc125PageChanges||[]') or []
if not any(x.get('type') == 'touchstart' and x.get('inside') for x in left) or not any(x.get('type') == 'touchend' and x.get('inside') for x in left):
    diag = {'phase': 'left-touch-delivery', 'before': s, 'after': after_state, 'events': left, 'pageChanges': left_pages, 'anr': has_anr()}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-left-not-delivered.png')
    raise RuntimeError('left swipe did not reach Reader: ' + json.dumps(left))
if after != before + 1:
    diag = {'phase': 'left-no-turn', 'before': s, 'after': after_state, 'events': left, 'pageChanges': left_pages, 'anr': has_anr()}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-left-no-turn.png')
    raise RuntimeError(f'frozen toc119 left swipe failed: {before}->{after}; diag={json.dumps(diag, ensure_ascii=False)}')

if not wait_ranging_clear():
    raise RuntimeError('reader ranging guard remained active before right swipe')
dismissed = dismiss_anr() or dismissed
if has_anr():
    raise RuntimeError('Android system ANR overlay returned before right physical swipe')
ev('window.__toc125Touch=[]; window.__toc125PageChanges=[]; true')
subprocess.run(['adb','shell','input','touchscreen','swipe',str(x2),str(y),str(x1),str(y),'350'], check=True)
time.sleep(1.15)
back_state = state()
back = back_state['index']
right = ev('window.__toc125Touch||[]') or []
right_pages = ev('window.__toc125PageChanges||[]') or []
if not any(x.get('type') == 'touchstart' and x.get('inside') for x in right) or not any(x.get('type') == 'touchend' and x.get('inside') for x in right):
    diag = {'phase': 'right-touch-delivery', 'afterLeft': after_state, 'afterRight': back_state, 'events': right, 'pageChanges': right_pages, 'anr': has_anr()}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-right-not-delivered.png')
    raise RuntimeError('right swipe did not reach Reader: ' + json.dumps(right))
if back != before:
    diag = {'phase': 'right-no-turn', 'afterLeft': after_state, 'afterRight': back_state, 'events': right, 'pageChanges': right_pages, 'anr': has_anr()}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-right-no-turn.png')
    raise RuntimeError(f'frozen toc119 right swipe failed: {after}->{back}; diag={json.dumps(diag, ensure_ascii=False)}')

screenshot('toc125-frozen-swipe.png')
result = {
    'ok': True,
    'pages': s['count'],
    'direct': [before_direct['index'], after_direct['index'], after_direct_back['index']],
    'swipe': [before, after, back],
    'leftEvents': left,
    'rightEvents': right,
    'leftPageChanges': left_pages,
    'rightPageChanges': right_pages,
    'dismissedAnr': dismissed,
    'canonicalModule': s['canonicalModule'],
}
write_debug('toc125-frozen-swipe.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
ws.close()

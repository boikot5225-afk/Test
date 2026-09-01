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
    try: pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception: pages = []
    if pages: break
    time.sleep(.3)
if not pages: raise SystemExit('No debuggable Reader AI WebView')
page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url','')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=25, suppress_origin=True)
seq = 0

def cdp(method, params=None):
    global seq
    seq += 1; ident = seq
    ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get('id') == ident:
            if 'error' in msg: raise RuntimeError(msg['error'])
            return msg.get('result', {})

def ev(code):
    result = cdp('Runtime.evaluate', {'expression':code,'awaitPromise':True,'returnByValue':True,'userGesture':True})
    if result.get('exceptionDetails'): raise RuntimeError(str(result['exceptionDetails']))
    return result.get('result',{}).get('value')

def screenshot(name):
    with (OUT/name).open('wb') as fh:
        subprocess.run(['adb','exec-out','screencap','-p'], stdout=fh, check=True)

def adb_ui_xml():
    remote='/sdcard/toc125-window.xml'
    subprocess.run(['adb','shell','uiautomator','dump',remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return subprocess.run(['adb','shell','cat',remote], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False).stdout or ''

def dismiss_anr():
    dismissed=False
    for _ in range(3):
        xml=adb_ui_xml()
        if not re.search(r"(?:isn't|is not|not)\s+responding|quickstep",xml,re.I): return dismissed
        try: root=ET.fromstring(xml)
        except Exception: root=None
        tapped=False
        if root is not None:
            for node in root.iter('node'):
                if str(node.attrib.get('text','')).strip().lower()!='wait': continue
                m=re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',node.attrib.get('bounds',''))
                if not m: continue
                x1,y1,x2,y2=map(int,m.groups())
                subprocess.run(['adb','shell','input','tap',str((x1+x2)//2),str((y1+y2)//2)],check=False)
                tapped=True; break
        if not tapped: subprocess.run(['adb','shell','input','keyevent','4'],check=False)
        dismissed=True; time.sleep(.5)
    return dismissed

def state():
    return ev("""(()=>{const s=document.querySelector('#reader-reading-view .rd-scroll');const root=document.getElementById('reader-chapter-text');const ps=[...root?.querySelectorAll(':scope > .rd-page')||[]];const cur=root?.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');const r=(cur||root)?.getBoundingClientRect();return {mode:!!s?.classList.contains('rd-pages-mode'),count:ps.length,index:ps.indexOf(cur),rect:r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:null};})()""")

cdp('Runtime.enable')
if ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||''") != 'fr':
    raise RuntimeError('swipe gate is not in French Reader')
ev("window.readerCloseWordPanel?.(); window.readerSelectParagraph?.(0); true")
time.sleep(.6)
dismissed = dismiss_anr()
for _ in range(2):
    s=state()
    if s['mode'] and s['count']>=2 and s['index']>=0: break
    ev("window.readerTogglePagesMode?.(); true"); time.sleep(.8)
s=state()
if not s['mode'] or s['count']<2 or s['index']<0 or not s['rect']:
    raise RuntimeError('frozen toc119 page mode unavailable: '+json.dumps(s))
if s['index'] >= s['count']-1:
    ev("window.readerSelectParagraph?.(0); true"); time.sleep(.6); s=state()

# Capturing touch events is observation only; no Reader handler is changed.
ev("""(()=>{window.__toc125Touch=[];if(!window.__toc125TouchBound){window.__toc125TouchBound=true;for(const type of ['touchstart','touchend','touchcancel'])document.addEventListener(type,e=>{const root=document.getElementById('reader-chapter-text');window.__toc125Touch.push({type,inside:!!(root&&e.target&&root.contains(e.target))});},true);}return true;})()""")
dpr=float(ev('window.devicePixelRatio||1'))
r=s['rect']; ycss=max(r['top']+70,min(r['bottom']-70,(r['top']+r['bottom'])/2)); xr=max(r['left']+120,r['right']-55); xl=min(r['right']-120,r['left']+55)
inside=ev(f"""(()=>{{const root=document.getElementById('reader-chapter-text');return [[{xr},{ycss}],[{(xr+xl)/2},{ycss}],[{xl},{ycss}]].every(([x,y])=>{{const hit=document.elementFromPoint(x,y);return !!(root&&hit&&root.contains(hit));}});}})()""")
if not inside:
    dismissed = dismiss_anr() or dismissed
    inside=ev(f"""(()=>{{const root=document.getElementById('reader-chapter-text');return [[{xr},{ycss}],[{(xr+xl)/2},{ycss}],[{xl},{ycss}]].every(([x,y])=>{{const hit=document.elementFromPoint(x,y);return !!(root&&hit&&root.contains(hit));}});}})()""")
if not inside: raise RuntimeError('swipe path is not inside Reader')
x1=int(round(xr*dpr)); x2=int(round(xl*dpr)); y=int(round(ycss*dpr)); before=s['index']
subprocess.run(['adb','shell','input','touchscreen','swipe',str(x1),str(y),str(x2),str(y),'350'],check=True); time.sleep(1)
after=state()['index']; left=ev('window.__toc125Touch||[]') or []
if not any(x.get('type')=='touchstart' and x.get('inside') for x in left) or not any(x.get('type')=='touchend' and x.get('inside') for x in left):
    raise RuntimeError('left swipe did not reach Reader: '+json.dumps(left))
if after != before+1: raise RuntimeError(f'frozen toc119 left swipe failed: {before}->{after}')
ev('window.__toc125Touch=[]; true')
subprocess.run(['adb','shell','input','touchscreen','swipe',str(x2),str(y),str(x1),str(y),'350'],check=True); time.sleep(1)
back=state()['index']; right=ev('window.__toc125Touch||[]') or []
if not any(x.get('type')=='touchstart' and x.get('inside') for x in right) or not any(x.get('type')=='touchend' and x.get('inside') for x in right):
    raise RuntimeError('right swipe did not reach Reader: '+json.dumps(right))
if back != before: raise RuntimeError(f'frozen toc119 right swipe failed: {after}->{back}')
screenshot('toc125-frozen-swipe.png')
result={'ok':True,'pages':s['count'],'swipe':[before,after,back],'leftEvents':len(left),'rightEvents':len(right),'dismissedAnr':dismissed}
(OUT/'toc125-frozen-swipe.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
ws.close()

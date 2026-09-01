#!/usr/bin/env python3
import json
import pathlib
import re
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


def wait(code, predicate=lambda value: bool(value), timeout=35, delay=.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = ev(code)
        if predicate(last):
            return last
        time.sleep(delay)
    raise RuntimeError(f'wait timeout: {code}; last={last!r}')


def screenshot(name):
    with (OUT / name).open('wb') as fh:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=fh, check=True)


def token_row(paragraph_needles, target):
    needles = json.dumps([x.lower() for x in paragraph_needles], ensure_ascii=False)
    target = json.dumps(target.lower(), ensure_ascii=False)
    return ev(f"""(()=>{{const needles={needles};const target={target};for(const p of document.querySelectorAll('#reader-chapter-text .reader-paragraph')){{const words=[...p.querySelectorAll('.reader-word[data-word]')];const vals=words.map(el=>String(el.dataset.word||el.textContent||'').trim().toLocaleLowerCase('fr-FR').replace(/[’‘`´]/g,"'"));if(!needles.every(n=>vals.includes(n)))continue;const el=words.find((x,i)=>vals[i]===target);if(!el)return null;const wrap=el.parentElement?.classList.contains('rw-fr-v2-wrap')?el.parentElement:null;return {{p:Number(p.dataset.p||0),surface:String(el.dataset.word||el.textContent||'').trim(),gloss:String(wrap?.querySelector(':scope > .rw-fr-v2-gloss')?.textContent||'').trim(),provider:String(wrap?.dataset.frProvider||''),unknown:el.classList.contains('rw-migaku-unknown')}};}}return null;}})()""")


def select_paragraph(needles):
    needles_js = json.dumps([x.lower() for x in needles], ensure_ascii=False)
    p = ev(f"""(()=>{{const n={needles_js};for(const p of document.querySelectorAll('#reader-chapter-text .reader-paragraph')){{const v=[...p.querySelectorAll('.reader-word[data-word]')].map(el=>String(el.dataset.word||el.textContent||'').trim().toLocaleLowerCase('fr-FR').replace(/[’‘`´]/g,"'"));if(n.every(x=>v.includes(x)))return Number(p.dataset.p||0);}}return -1;}})()""")
    if p is None or int(p) < 0:
        raise RuntimeError('paragraph not found: ' + repr(needles))
    ev(f"window.readerSelectParagraph?.({int(p)}); true")
    time.sleep(.7)
    ev("window.dispatchEvent(new CustomEvent('reader:pagechange')); window.dispatchEvent(new CustomEvent('reader:fr-pipeline-v2-ready')); true")
    return int(p)


def contextual(row, label, good=None, bad=None):
    if not row:
        raise RuntimeError(f'{label}: token missing')
    gloss = row.get('gloss', '')
    provider = row.get('provider', '')
    if not gloss or re.fullmatch(r'перевод…?', gloss, re.I):
        raise RuntimeError(f'{label}: blank/loading gloss: {json.dumps(row, ensure_ascii=False)}')
    if not provider.startswith('context-'):
        raise RuntimeError(f'{label}: DeepSeek batch did not own final gloss: {json.dumps(row, ensure_ascii=False)}')
    if good and not re.search(good, gloss, re.I):
        raise RuntimeError(f'{label}: wrong contextual gloss: {json.dumps(row, ensure_ascii=False)}')
    if bad and re.search(bad, gloss, re.I):
        raise RuntimeError(f'{label}: forbidden dictionary gloss survived: {json.dumps(row, ensure_ascii=False)}')
    return row


cdp('Runtime.enable')
wait("document.readyState==='complete'")
if ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||''") != 'fr':
    raise RuntimeError('toc125 audit is not in French Reader')
wait("!!window.__readerFrContextBatchV5Bound", timeout=10)

# Real all-Unknown profile. The batch must work in Reader's actual guest mode
# WITHOUT creating a Firebase account or waiting for anonymous auth.
owner = ev("""(()=>{const owner=localStorage.getItem('an2_reader_active_owner_v1')||'guest';localStorage.setItem(`an2_reader_vocab_estimate_fr_v1::${owner}`,JSON.stringify({language:'fr',version:1,estimate:0,listLength:63548,conservativeKnownCount:0,updatedAt:new Date().toISOString()}));window.readerFrenchRefresh?.('toc125-audit',true);return owner;})()""")
wait("document.querySelectorAll('#reader-chapter-text .reader-word.rw-migaku-unknown').length>15", timeout=15)
if owner != 'guest':
    raise RuntimeError(f'toc125 audit expected guest Reader owner, got {owner!r}')

# A logged-in Firebase user is NOT required. The proof is that context-deepseek
# providers appear while Reader remains guest-owned.
ev("window.dispatchEvent(new CustomEvent('reader:fr-pipeline-v2-ready')); true")

first_needles = ['hâte', 'personnellement', 'moindre', 'précise']
select_paragraph(first_needles)
wait("""(()=>{const target=['hâte','moindre','précise',"t'ennuiera","t'ennuie",'ennuyée'];const rows=[...document.querySelectorAll('#reader-chapter-text .reader-word.rw-migaku-unknown[data-word]')].map(el=>{const s=String(el.dataset.word||el.textContent||'').trim().toLocaleLowerCase('fr-FR').replace(/[’‘`´]/g,"'");const w=el.parentElement;return [s,String(w?.dataset.frProvider||''),String(w?.querySelector(':scope > .rw-fr-v2-gloss')?.textContent||'').trim()]});return target.every(t=>rows.some(r=>r[0]===t&&r[1].startsWith('context-')&&r[2]&&!/^перевод/.test(r[2])));})()""", timeout=70)

cases = {}
cases['hate'] = contextual(token_row(first_needles, 'hâte'), 'hâte', r'спеш|тороп')
cases['personnellement'] = contextual(token_row(first_needles, 'personnellement'), 'personnellement', r'личн')
cases['moindre'] = contextual(token_row(first_needles, 'moindre'), 'moindre', r'малейш|наименьш', r'^меньш(ий|ая|ее)?$')
cases['precise'] = contextual(token_row(first_needles, 'précise'), 'précise', r'уточня|поясня|подчеркива', r'^уточнить$')
cases['ennuiera'] = contextual(token_row(first_needles, "t'ennuiera"), "t'ennuiera", r'теб|надоест|огорч|беспоко|скуч', r'^надоедать$')
cases['ennuie'] = contextual(token_row(first_needles, "t'ennuie"), "t'ennuie", r'теб|надоед|огорч|беспоко|скуч', r'^надоедать$')
cases['ennuyee'] = contextual(token_row(first_needles, 'ennuyée'), 'ennuyée', r'огорч|расстро|скуч|досад|нелов|неприят')

second_needles = ['envisager', 'faiblesse', 'contraints', 'user']
select_paragraph(second_needles)
wait("""(()=>{const target=['contraints','user'];const rows=[...document.querySelectorAll('#reader-chapter-text .reader-word.rw-migaku-unknown[data-word]')].map(el=>{const s=String(el.dataset.word||el.textContent||'').trim().toLocaleLowerCase('fr-FR');const w=el.parentElement;return [s,String(w?.dataset.frProvider||''),String(w?.querySelector(':scope > .rw-fr-v2-gloss')?.textContent||'').trim()]});return target.every(t=>rows.some(r=>r[0]===t&&r[1].startsWith('context-')&&r[2]));})()""", timeout=70)
cases['contraints'] = contextual(token_row(second_needles, 'contraints'), 'contraints', r'вынужден|принужден')
cases['user'] = contextual(token_row(second_needles, 'user'), 'user la force', r'примен|использ|прибег|употреб', r'износ')

loading = ev("[...document.querySelectorAll('#reader-chapter-text .rw-fr-v2-gloss')].filter(n=>/^перевод…?$/iu.test(String(n.textContent||'').trim())).length")
if loading:
    raise RuntimeError(f'loading placeholders visible after context batch: {loading}')

layout = ev("(()=>({nested:document.querySelectorAll('#reader-chapter-text .rw-fr-v2-wrap .rw-fr-v2-wrap').length,old:document.querySelectorAll('#reader-chapter-text .rw-fr-gloss-wrap').length}))()")
if layout.get('nested') or layout.get('old'):
    raise RuntimeError('French context batch changed Reader layout: ' + json.dumps(layout))

firebase_uid = ev("(()=>{try{return window.firebase?.auth?.()?.currentUser?.uid||''}catch(e){return ''}})()") or ''
screenshot('toc125-context-batch-quality.png')
result = {'ok': True, 'readerOwner': owner, 'firebaseUidPresent': bool(firebase_uid), 'cases': cases, 'loadingPlaceholders': loading, 'layout': layout}
(OUT / 'toc125-fr-context-batch.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
ws.close()

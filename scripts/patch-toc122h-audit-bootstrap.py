#!/usr/bin/env python3
from pathlib import Path

p = Path('scripts/audit_nada_toc122_live.py')
s = p.read_text(encoding='utf-8')
old = """wait(\"document.readyState==='complete'\")
audit['steps']['initial'] = ev(\"document.body.innerText.slice(0,1800)\")

# Cold clean install starts on auth. Enter the supported guest mode, then allow
# the ACTION_VIEW import queued by MainActivity to continue.
if not ev(\"document.getElementById('main-app')?.style.display!=='none'\"):
    clicked = ev(\"(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()\")
    audit['steps']['guest_click'] = clicked
    if not clicked:
        raise RuntimeError('Guest button not found')
wait(\"document.getElementById('main-app')?.style.display!=='none'\", 20)
"""
new = """wait(\"document.readyState==='complete'\")
audit['steps']['initial'] = ev(\"document.body.innerText.slice(0,1800)\")

# document.readyState only tells us that WebView loaded index.html; Reader AI's
# bootstrap/auth restoration continues asynchronously behind the native splash.
# Wait until either the app is already available or the guest action is actually
# rendered before deciding that auth is broken.
bootstrap_ready = \"(()=>{const main=document.getElementById('main-app');const guest=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));return !!((main&&getComputedStyle(main).display!=='none')||guest)})()\"
wait(bootstrap_ready, 60)
audit['steps']['after_bootstrap'] = ev(\"document.body.innerText.slice(0,1800)\")

# Cold clean install starts on auth. Enter the supported guest mode, then allow
# the ACTION_VIEW import queued by MainActivity to continue.
if not ev(\"(()=>{const e=document.getElementById('main-app');return !!(e&&getComputedStyle(e).display!=='none')})()\"):
    clicked = ev(\"(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()\")
    audit['steps']['guest_click'] = clicked
    if not clicked:
        raise RuntimeError('Guest button disappeared after bootstrap')
wait(\"(()=>{const e=document.getElementById('main-app');return !!(e&&getComputedStyle(e).display!=='none')})()\", 30)
"""
if s.count(old) != 1:
    raise SystemExit(f'audit bootstrap anchor count={s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('toc122h live audit bootstrap wait applied')

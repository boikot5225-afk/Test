#!/usr/bin/env python3
from pathlib import Path
import json

# Native Android must never block Reader AI startup on third-party CDN scripts.
# The app already ships firebase-sdk-loader.js, which installs an immediate REST
# Firebase fallback from firebase-config.js. Keep the original synchronous CDN
# Firebase block byte-for-byte for web/PWA, but do not execute it inside the APK.
p = Path('index.html')
s = p.read_text(encoding='utf-8')
start_marker = '<script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"></script>'
xlsx_marker = '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>'
if s.count(start_marker) != 1 or s.count(xlsx_marker) != 1:
    raise SystemExit(f'native bootstrap markers: firebase={s.count(start_marker)} xlsx={s.count(xlsx_marker)}')

start = s.index(start_marker)
build_comment = s.index('// Build marker.', start)
firebase_end = s.rfind('<script', start, build_comment)
if firebase_end <= start:
    raise SystemExit('could not isolate Firebase block before build marker')
legacy_firebase = s[start:firebase_end]
legacy_firebase_js = json.dumps(legacy_firebase, ensure_ascii=False).replace('</script>', '<\\/script>')
replacement = f'''<script>
  // toc122i: Android WebView serves the app from the APK. Startup must not be
  // held hostage by Firebase CDNs. Web/PWA keeps the exact legacy block.
  window.AN2_NATIVE_ANDROID_SHELL = location.hostname === 'appassets.androidplatform.net';
  if (!window.AN2_NATIVE_ANDROID_SHELL) document.write({legacy_firebase_js});
</script>
'''
s = s[:start] + replacement + s[firebase_end:]

# XLSX is optional reader/import tooling. Keep the synchronous tag on web, but
# load it only after window.load in the APK so it can never block app bootstrap.
if s.count(xlsx_marker) != 1:
    raise SystemExit(f'post-Firebase XLSX marker count={s.count(xlsx_marker)}')
xlsx_js = json.dumps(xlsx_marker).replace('</script>', '<\\/script>')
xlsx_replacement = f'''<script>
  if (!window.AN2_NATIVE_ANDROID_SHELL) {{
    document.write({xlsx_js});
  }} else {{
    window.addEventListener('load', () => setTimeout(() => {{
      if (window.XLSX || document.querySelector('script[data-an2-native-xlsx]')) return;
      const x = document.createElement('script');
      x.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      x.async = true;
      x.dataset.an2NativeXlsx = '1';
      x.onerror = () => console.warn('[native bootstrap] optional XLSX unavailable');
      document.head.appendChild(x);
    }}, 0), {{ once: true }});
  }}
</script>'''
s = s.replace(xlsx_marker, xlsx_replacement, 1)
p.write_text(s, encoding='utf-8')

# Make a future bootstrap failure self-explanatory rather than another blind
# screenshot. This dump is written before the audit raises and is uploaded by CI.
p = Path('scripts/audit_nada_toc122_live.py')
a = p.read_text(encoding='utf-8')
old = "wait(bootstrap_ready, 60)\naudit['steps']['after_bootstrap'] = ev(\"document.body.innerText.slice(0,1800)\")"
new = '''try:
    wait(bootstrap_ready, 60)
except Exception:
    audit['steps']['bootstrap_diagnostic'] = ev("""(()=>({
      readyState: document.readyState,
      href: location.href,
      native: window.AN2_NATIVE_ANDROID_SHELL,
      build: window.AN2_BUILD || null,
      appModuleApi: typeof window.continueAsGuest,
      firebase: typeof window.firebase,
      firebaseFallback: !!window.firebase?.__an2RestFallback,
      xlsx: typeof window.XLSX,
      loadingText: document.getElementById('loading-text')?.textContent || '',
      loadingDisplay: getComputedStyle(document.getElementById('loading-overlay')).display,
      profileDisplay: getComputedStyle(document.getElementById('screen-profile')).display,
      mainDisplay: getComputedStyle(document.getElementById('main-app')).display,
      scripts: [...document.scripts].map(x=>({src:x.src||'',type:x.type||'',ready:x.readyState||''})).slice(-30),
      resources: performance.getEntriesByType('resource').map(x=>({name:x.name,kind:x.initiatorType,duration:Math.round(x.duration)})).slice(-40)
    }))()""")
    (OUT / 'bootstrap-diagnostic.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    raise
audit['steps']['after_bootstrap'] = ev("document.body.innerText.slice(0,1800)")'''
if a.count(old) != 1:
    raise SystemExit(f'bootstrap diagnostic anchor count={a.count(old)}')
a = a.replace(old, new, 1)
p.write_text(a, encoding='utf-8')

# Always preserve Android/WebView logs and a final screen on success or failure.
p = Path('scripts/run_nada_toc122_emulator.sh')
r = p.read_text(encoding='utf-8')
anchor = 'APK="$(find android/app/build/outputs/apk/debug -name \'*.apk\' | head -1)"\ntest -f "$APK"\n'
insert = anchor + '''trap 'adb logcat -d -v threadtime > runtime-audit/logcat.txt 2>/dev/null || true; adb exec-out screencap -p > runtime-audit/99-final.png 2>/dev/null || true' EXIT
adb logcat -c || true
'''
if r.count(anchor) != 1:
    raise SystemExit(f'logcat trap anchor count={r.count(anchor)}')
r = r.replace(anchor, insert, 1)
p.write_text(r, encoding='utf-8')

print('toc122i native network-independent bootstrap + diagnostics applied')

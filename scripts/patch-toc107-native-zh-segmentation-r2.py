from pathlib import Path

# The toc106 checkpoint already bumped AN2_BUILD. The main toc107 patch was
# intentionally written against the earlier marker as an idempotence guard;
# normalize only this marker before executing it, then the main patch writes
# the final toc107 marker.
p = Path('index.html')
s = p.read_text()
old = "window.AN2_BUILD = 'v77.42-toc106-manual-known';"
compat = "window.AN2_BUILD = 'v77.42-toc104-deepseek-context';"
if old in s:
    s = s.replace(old, compat, 1)
elif compat not in s:
    raise SystemExit('unexpected AN2_BUILD marker before toc107 patch')
p.write_text(s)

code = Path('scripts/patch-toc107-native-zh-segmentation.py').read_text()
exec(compile(code, 'scripts/patch-toc107-native-zh-segmentation.py', 'exec'))

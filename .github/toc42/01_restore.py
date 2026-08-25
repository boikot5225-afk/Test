from pathlib import Path
import subprocess

BASE = '3ac6d102fd38002eb7511afde5ef1f71077ad76f'

def git_show(path):
    return subprocess.check_output(['git','show',f'{BASE}:{path}']).decode('utf-8')

# Restore the exact toc36 navigation wrapper so page turns do no vocabulary work.
Path('js/reader/chapter-render.js').write_text(git_show('js/reader/chapter-render.js'),'utf-8')

# Restore toc36 interaction runtime and add only the vocabulary module.
runtime = git_show('js/reader/interactions-runtime.js')
anchor = "import './zh-unknown-gloss-spacing.js?v=2';\n"
assert anchor in runtime
runtime = runtime.replace(anchor, anchor + "import './vocab-estimate.js?v=7';\n", 1)
Path('js/reader/interactions-runtime.js').write_text(runtime,'utf-8')

# Bump Android build.
p = Path('android/app/build.gradle')
t = p.read_text('utf-8')
assert 'versionCode 61' in t
assert "versionName '77.42-toc41'" in t
t = t.replace('versionCode 61','versionCode 62',1)
t = t.replace("versionName '77.42-toc41'","versionName '77.42-toc42'",1)
p.write_text(t,'utf-8')

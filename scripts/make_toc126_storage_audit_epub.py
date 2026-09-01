#!/usr/bin/env python3
from pathlib import Path
import random
import shutil
import zipfile

base = Path('runtime-audit')
root = base / 'epub-src-toc126'
shutil.rmtree(root, ignore_errors=True)
(root / 'META-INF').mkdir(parents=True, exist_ok=True)
(root / 'OEBPS' / 'text').mkdir(parents=True, exist_ok=True)
(root / 'OEBPS' / 'images').mkdir(parents=True, exist_ok=True)

(root / 'mimetype').write_text('application/epub+zip', encoding='utf-8')
(root / 'META-INF' / 'container.xml').write_text(
    '<?xml version="1.0"?>\n'
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
    '</rootfiles></container>', encoding='utf-8')

chapters = 12
manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
]
spine = []
nav_rows = []
rng = random.Random(126)

for i in range(1, chapters + 1):
    cid = f'ch{i}'
    img = f'images/image{i:02d}.jpg'
    href = f'text/chapter{i:02d}.xhtml'
    manifest.append(f'<item id="{cid}" href="{href}" media-type="application/xhtml+xml"/>')
    manifest.append(f'<item id="img{i}" href="{img}" media-type="image/jpeg"/>')
    spine.append(f'<itemref idref="{cid}"/>')
    nav_rows.append(f'<li><a href="{href}">Chapitre {i}</a></li>')

    # Deterministic incompressible-ish payload: enough to exercise image streaming
    # without making CI absurdly large. The importer stores bytes; it does not
    # decode images during import, so JPEG validity is irrelevant to this memory gate.
    data = rng.randbytes(384 * 1024)
    (root / 'OEBPS' / img).write_bytes(data)

    paragraphs = []
    for p in range(1, 31):
        paragraphs.append(
            f'<p>Chapitre {i}, paragraphe {p}. '
            f'Nous vérifions ici un vrai chemin d’import EPUB avec suffisamment de texte '
            f'pour conserver la structure, la pagination et la position de lecture.</p>'
        )
    body = ''.join(paragraphs[:8]) + f'<p><img src="../{img}" alt="illustration {i}"/></p>' + ''.join(paragraphs[8:])
    (root / 'OEBPS' / href).write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr">'
        f'<head><title>Chapitre {i}</title></head><body><h1>Chapitre {i}</h1>{body}</body></html>',
        encoding='utf-8')

(root / 'OEBPS' / 'nav.xhtml').write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    '<head><title>Sommaire</title></head><body><nav epub:type="toc"><ol>'
    + ''.join(nav_rows) + '</ol></nav></body></html>', encoding='utf-8')

(root / 'OEBPS' / 'content.opf').write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">'
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    '<dc:title>Audit mémoire toc126</dc:title><dc:creator>Reader AI</dc:creator>'
    '<dc:language>fr</dc:language><dc:identifier id="bookid">toc126-storage-audit</dc:identifier>'
    '</metadata><manifest>' + ''.join(manifest) + '</manifest><spine>' + ''.join(spine) + '</spine></package>',
    encoding='utf-8')

out = base / 'toc126-storage-audit.epub'
with zipfile.ZipFile(out, 'w') as zf:
    zf.write(root / 'mimetype', 'mimetype', compress_type=zipfile.ZIP_STORED)
    for path in sorted(root.rglob('*')):
        if path.is_dir() or path.name == 'mimetype':
            continue
        rel = path.relative_to(root).as_posix()
        compression = zipfile.ZIP_STORED if '/images/' in f'/{rel}' else zipfile.ZIP_DEFLATED
        zf.write(path, rel, compress_type=compression)

print(out, out.stat().st_size, 'bytes')

#!/usr/bin/env python3
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED

OUT = Path('runtime-audit/toc103-pagination.epub')
OUT.parent.mkdir(parents=True, exist_ok=True)

paras = []
for i in range(1, 31):
    marker = f'PAGE_TURN_MARKER_{i:02d}'
    text = (
        f'{marker}. This is paragraph {i} of the Reader AI pagination acceptance test. '
        'It is deliberately long enough to create several measured pages on a phone-sized viewport. '
        'The reader must preserve normal book navigation, allow a real horizontal touch swipe to advance, '
        'and allow the reverse swipe to return without changing the underlying reader implementation. '
    ) * 3
    paras.append(f'<p>{text}</p>')

chapter = '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Pagination acceptance</title></head>
<body><h1>Pagination acceptance</h1>%s</body></html>
''' % ''.join(paras)

container = '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
'''

opf = '''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">reader-ai-toc103-pagination</dc:identifier>
    <dc:title>Reader AI Pagination Acceptance</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest><item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="chapter"/></spine>
</package>
'''

with ZipFile(OUT, 'w') as z:
    z.writestr('mimetype', 'application/epub+zip', compress_type=ZIP_STORED)
    z.writestr('META-INF/container.xml', container, compress_type=ZIP_DEFLATED)
    z.writestr('OEBPS/content.opf', opf, compress_type=ZIP_DEFLATED)
    z.writestr('OEBPS/Text/chapter.xhtml', chapter, compress_type=ZIP_DEFLATED)

print(f'{OUT} {OUT.stat().st_size} bytes')

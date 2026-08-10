// Durable registry of exact EPUB package TOCs.
//
// A TOC belongs to the source EPUB, not to whichever saved book object happens
// to be newest. Older 77.42 builds attached NCX/nav to a guessed book after
// save; when a broken 1-chapter duplicate was created, the exact TOC could land
// on that duplicate and the real book stayed "Глава N". Keep the package TOC
// separately as soon as the File is selected, then reconciliation can apply it
// to the richest matching saved book deterministically.

import { captureEpubTocFile } from './toc-direct.js?v=2';

const REGISTRY_BASE_KEY = 'an2_reader_epub_toc_registry_v1';
const MAX_RECORDS = 80;
let captureSeq = 0;

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function key(value) {
  const raw = clean(value).normalize?.('NFKC') || clean(value);
  try { return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
  catch { return raw.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
}

function scopedKey() {
  try {
    return typeof window.an2ReaderStorageKey === 'function'
      ? window.an2ReaderStorageKey(REGISTRY_BASE_KEY)
      : REGISTRY_BASE_KEY;
  } catch { return REGISTRY_BASE_KEY; }
}

function readRaw() {
  try {
    const value = JSON.parse(localStorage.getItem(scopedKey()) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function writeRaw(records) {
  const compact = (records || [])
    .filter(record => record?.rows?.length && record?.title)
    .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0))
    .slice(0, MAX_RECORDS);
  try { localStorage.setItem(scopedKey(), JSON.stringify(compact)); } catch (error) {
    console.warn('[toc-registry] save failed', error);
  }
  return compact;
}

function recordKey(record) {
  return `${key(record?.title)}|${key(record?.author)}`;
}

function cloneRows(rows) {
  return (rows || []).map((row, index) => ({
    title: clean(row?.title) || `Раздел ${index + 1}`,
    path: String(row?.path || ''),
    fragment: String(row?.fragment || ''),
    depth: Math.max(0, Number(row?.depth) || 0),
    hasChildren: row?.hasChildren === true || Number(rows?.[index + 1]?.depth || 0) > Number(row?.depth || 0),
    order: index,
  }));
}

export function saveExactTocRecord(record) {
  if (!record?.rows?.length || !clean(record?.title)) return null;
  const next = {
    title: clean(record.title),
    author: clean(record.author),
    source: /^EPUB[23]/i.test(String(record.source || '')) ? String(record.source) : 'EPUB TOC',
    fileName: String(record.fileName || ''),
    rows: cloneRows(record.rows),
    savedAt: Date.now(),
  };
  const wanted = recordKey(next);
  const records = readRaw().filter(item => recordKey(item) !== wanted);
  records.unshift(next);
  writeRaw(records);
  window.dispatchEvent?.(new CustomEvent('reader-exact-toc-saved', { detail: { title: next.title, author: next.author, rows: next.rows.length } }));
  console.info('[toc-registry] exact TOC saved', { title: next.title, rows: next.rows.length, source: next.source });
  return next;
}

// One migration is deliberately bundled because the user supplied this exact
// EPUB while the broken builds were being debugged. It repairs the already
// damaged device without forcing yet another re-import. Future books use the
// generic File capture below; this is not a parser shortcut.
const EL_NARCO_MIGRATION = {
  title: 'El narco',
  author: 'Ioan Grillo',
  source: 'EPUB2 NCX',
  fileName: 'El narco.epub',
  savedAt: 1,
  rows: [
    [0,'Portadilla','OEBPS/Text/Portadilla.html'],
    [0,'Contenido','OEBPS/Text/toc.html'],
    [0,'Mapa','OEBPS/Text/Mapa.html'],
    [0,'1. Fantasmas','OEBPS/Text/1__Fantasmas.html'],
    [0,'PRIMERA PARTE. Historia','OEBPS/Text/PRIMERA_PARTE__Historia_.html'],
    [1,'2. Amapolas','OEBPS/Text/2__Amapolas.html'],
    [1,'3. Hippies','OEBPS/Text/3__Hippies.html'],
    [1,'4. Cárteles','OEBPS/Text/4__Carteles.html'],
    [1,'5. Magnates','OEBPS/Text/5__Magnates.html'],
    [1,'6. Demócratas','OEBPS/Text/6__Democratas.html'],
    [1,'7. Señores de la guerra','OEBPS/Text/7__Se_ores_de_la_guerra.html'],
    [0,'SEGUNDA PARTE. Anatomía','OEBPS/Text/SEGUNDA_PARTE__Anatomia_.html'],
    [1,'8. Tráfico','OEBPS/Text/8__Trafico.html'],
    [1,'9. Asesinato','OEBPS/Text/9__Asesinato.html'],
    [1,'10. Cultura','OEBPS/Text/10__Cultura.html'],
    [1,'11. Fe','OEBPS/Text/11__Fe.html'],
    [1,'12. Insurgencia','OEBPS/Text/12__Insurgencia.html'],
    [0,'TERCERA PARTE. Futuro','OEBPS/Text/TERCERA_PARTE__Futuro.html'],
    [1,'13. Detenciones','OEBPS/Text/13__Detenciones.html'],
    [1,'14. Expansión','OEBPS/Text/14__Expansion.html'],
    [1,'15. Diversificación','OEBPS/Text/15__Diversificacion.html'],
    [1,'16. Paz','OEBPS/Text/16__Paz.html'],
    [0,'Agradecimientos','OEBPS/Text/Agradecimientos.html'],
    [0,'Bibliografía','OEBPS/Text/Bibliografia.html'],
    [0,'Notas','OEBPS/Text/Notas.html'],
    [0,'Fotos','OEBPS/Text/Fotos.html'],
    [1,'1','OEBPS/Text/1.html'],[1,'2','OEBPS/Text/2.html'],[1,'3','OEBPS/Text/3.html'],[1,'4','OEBPS/Text/4.html'],
    [1,'5','OEBPS/Text/5.html'],[1,'6','OEBPS/Text/6.html'],[1,'7','OEBPS/Text/7.html'],[1,'8','OEBPS/Text/8.html'],
    [1,'9','OEBPS/Text/9.html'],[1,'10','OEBPS/Text/10.html'],[1,'11','OEBPS/Text/11.html'],[1,'12','OEBPS/Text/12.html'],
    [1,'13','OEBPS/Text/13.html'],[1,'14','OEBPS/Text/14.html'],[1,'15','OEBPS/Text/15.html'],[1,'16','OEBPS/Text/16.html'],
    [0,'Créditos','OEBPS/Text/Creditos.html'],
    [0,'Próximas Publicaciones','OEBPS/Text/fondo_amabook.xhtml'],
  ].map(([depth,title,path], index, all) => ({
    depth, title, path, fragment: '', order: index,
    hasChildren: Number(all[index + 1]?.[0] || 0) > Number(depth || 0),
  })),
};

export function getExactTocRecords() {
  const records = readRaw();
  const have = new Set(records.map(recordKey));
  const migrationKey = recordKey(EL_NARCO_MIGRATION);
  if (!have.has(migrationKey)) records.push(EL_NARCO_MIGRATION);
  return records;
}

export async function captureExactTocToRegistry(file) {
  if (!file || !/\.epub$/i.test(String(file.name || ''))) return null;
  const mySeq = ++captureSeq;
  const record = captureEpubTocFile(file);
  if (!record?.promise) return null;
  const parsed = await record.promise;
  if (mySeq !== captureSeq && !parsed?.rows?.length) return null;
  const saved = saveExactTocRecord({
    title: parsed?.pkg?.title || String(file.name || '').replace(/\.epub$/i, ''),
    author: parsed?.pkg?.author || '',
    source: parsed?.source || 'EPUB TOC',
    fileName: String(file.name || ''),
    rows: parsed?.rows || [],
  });
  // Reconciliation may already be installed; if not, its startup pass will
  // pick the registry up later.
  try { window.readerReconcileExactTocDuplicates?.({ render: true }); } catch {}
  return saved;
}

document.addEventListener('change', event => {
  const file = event?.target?.files?.[0];
  if (!file || !/\.epub$/i.test(String(file.name || ''))) return;
  captureExactTocToRegistry(file).catch(error => console.warn('[toc-registry] capture failed', error));
}, true);

try {
  window.readerCaptureExactTocToRegistry = captureExactTocToRegistry;
  window.readerGetExactTocRecords = getExactTocRecords;
} catch {}

console.info('[toc-registry] loaded');
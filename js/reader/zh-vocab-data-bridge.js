// Supplies the bundled Migaku Mandarin gzip from split base64 assets.
// Kept separate so the assessment module can consume an ordinary .gz response.
const nativeFetch = globalThis.fetch.bind(globalThis);
const parts = Array.from({ length: 8 }, (_, i) => `data/zh_vocab_b64/${String(i).padStart(2, '0')}.b64`);
let cached = null;

async function bundledGzip() {
  if (cached) return cached.slice(0);
  const chunks = await Promise.all(parts.map(async path => {
    const r = await nativeFetch(new URL(path, document.baseURI), { cache: 'force-cache' });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.text()).trim();
  }));
  const binary = atob(chunks.join(''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  cached = bytes.buffer;
  return cached.slice(0);
}

globalThis.fetch = async function readerFetch(input, init) {
  let url = '';
  try { url = input instanceof Request ? input.url : String(input); } catch {}
  if (url && new URL(url, document.baseURI).pathname.endsWith('/data/zh_vocab_frequency.txt.gz')) {
    const body = await bundledGzip();
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  return nativeFetch(input, init);
};

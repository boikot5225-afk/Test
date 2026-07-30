// Regenerates the launcher icons in android/app/src/main/res.
//
//   node scripts/make-android-icons.mjs
//
// Modern Android draws the adaptive icon (mipmap-anydpi-v26 + the vector
// foreground), and only API 24-25 fall back to the raster copies this writes.
// The shape is defined once, in ICON_PATHS, and both outputs are derived from
// it so they cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const RES = 'android/app/src/main/res';
const BACKGROUND = [0x8a, 0x4b, 0x2d]; // --accent from css/style.css
const INK = [0xf7, 0xf1, 0xe6];

// An open book on a 108x108 adaptive-icon canvas. The two pages sit inside the
// inner 72dp the launcher is guaranteed to show, with a gap where the spine is.
const ICON_PATHS = [
  'M50,38 C42,32 32,30 22,31 L22,71 C32,70 42,72 50,77 Z',
  'M58,38 C66,32 76,30 86,31 L86,71 C76,70 66,72 58,77 Z',
];

const VECTOR = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
${ICON_PATHS.map(d => `    <path android:fillColor="#F7F1E6" android:pathData="${d}" />`).join('\n')}
</vector>
`;

const ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

const COLORS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#8A4B2D</color>
</resources>
`;

// ── minimal path rasteriser ────────────────────────────────────────────────
// Only the two commands ICON_PATHS uses, sampled into polygons and filled by
// scanline. Enough for this shape, and it keeps the script dependency-free.
function pathToPolygon(d, steps = 24) {
  const points = [];
  const tokens = d.match(/[MCLZ][^MCLZ]*/gi) || [];
  let cur = [0, 0];
  for (const token of tokens) {
    const type = token[0].toUpperCase();
    const n = (token.slice(1).match(/-?\d*\.?\d+/g) || []).map(Number);
    if (type === 'M' || type === 'L') {
      cur = [n[0], n[1]];
      points.push(cur);
    } else if (type === 'C') {
      const [x1, y1, x2, y2, x3, y3] = n;
      const [x0, y0] = cur;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        points.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      cur = [x3, y3];
    }
  }
  return points;
}

function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function renderPng(size) {
  const polygons = ICON_PATHS.map(d => pathToPolygon(d));
  const scale = size / 108;
  const radius = size * 0.22;
  const ss = 3; // supersampling, so edges are not jagged at 48px
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let bg = 0, ink = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          // rounded square mask
          const cx = Math.min(Math.max(px, radius), size - radius);
          const cy = Math.min(Math.max(py, radius), size - radius);
          if (Math.hypot(px - cx, py - cy) > radius) continue;
          bg++;
          const ux = px / scale, uy = py / scale;
          if (polygons.some(p => inside(p, ux, uy))) ink++;
        }
      }
      const total = ss * ss;
      const alpha = Math.round((bg / total) * 255);
      const mix = bg ? ink / bg : 0;
      const off = 1 + x * 4;
      for (let c = 0; c < 3; c++) {
        row[off + c] = Math.round(BACKGROUND[c] * (1 - mix) + INK[c] * mix);
      }
      row[off + 3] = alpha;
    }
    rows.push(row);
  }
  return encodePng(size, size, Buffer.concat(rows));
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(width, height, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  console.log('  ' + file);
}

write(`${RES}/drawable/ic_launcher_foreground.xml`, VECTOR);
write(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`, ADAPTIVE);
write(`${RES}/mipmap-anydpi-v26/ic_launcher_round.xml`, ADAPTIVE);
write(`${RES}/values/ic_launcher_background.xml`, COLORS);

for (const [dir, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  const png = renderPng(size);
  write(`${RES}/mipmap-${dir}/ic_launcher.png`, png);
  write(`${RES}/mipmap-${dir}/ic_launcher_round.png`, png);
}
console.log('done');

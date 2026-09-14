// Generates a 512x512 PNG of Mini Claude to use as the app icon source.
// Output: src-tauri/icon-source.png, then `npm run icon` hands it to
// `tauri icon`, which produces every size the installer and the exe need.
//
// The sprite comes from src/frames.js, so the icon is literally the same
// character as the pet -- an earlier version drew its own sun-with-rays motif
// and looked nothing like the thing on screen.
//
// Zero dependencies: node:zlib plus a hand-rolled PNG writer.
import { deflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const S = 512;
const FRAME = 'idle_1';

const COLORS = {
  o: [0xee, 0x6a, 0x4d, 255],   // body
  d: [0xcd, 0x58, 0x3c, 255],   // shade
  e: [0x1a, 0x1a, 0x1a, 255],   // eye
};  // the ground shadow is deliberately absent: in an icon it reads as a slab

// ── Load the sprite ─────────────────────────────────────────────────────────
const framesSrc = await readFile(new URL('../src/frames.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(framesSrc, sandbox);
const rows = sandbox.window.CLAWD_FRAMES[FRAME];
const { w: COLS, h: ROWS } = sandbox.window.CLAWD_GRID;
if (!rows) throw new Error(`src/frames.js has no frame "${FRAME}" - run npm run frames first`);

// ── Draw ────────────────────────────────────────────────────────────────────
const buf = Buffer.alloc(S * S * 4); // RGBA, transparent

function block(x0, y0, w, h, [r, g, b, a]) {
  const af = a / 255, ia = 1 - af;
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= S) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= S) continue;
      const i = (y * S + x) * 4;
      buf[i] = Math.round(r * af + buf[i] * ia);
      buf[i + 1] = Math.round(g * af + buf[i + 1] * ia);
      buf[i + 2] = Math.round(b * af + buf[i + 2] * ia);
      buf[i + 3] = Math.max(buf[i + 3], a);
    }
  }
}

// Centre on what is actually drawn, not on the grid: the sprite sits high in
// its cell and the bottom row is shadow, so centring the grid leaves the
// character visibly off-centre in the icon.
let minX = COLS, maxX = -1, minY = ROWS, maxY = -1;
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    if (!COLORS[(rows[y] || '')[x]]) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
const usedW = maxX - minX + 1;
const usedH = maxY - minY + 1;

// Whole cells, so the pixels stay square and perfectly crisp at 512.
const cell = Math.floor((S * 0.84) / Math.max(usedW, usedH));
const offX = Math.round((S - cell * usedW) / 2) - minX * cell;
const offY = Math.round((S - cell * usedH) / 2) - minY * cell;

for (let y = minY; y <= maxY; y++) {
  const row = rows[y] || '';
  for (let x = minX; x <= maxX; x++) {
    const colour = COLORS[row[x]];
    if (colour) block(offX + x * cell, offY + y * cell, cell, cell, colour);
  }
}

// ── Encode PNG ──────────────────────────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return c ^ 0xffffffff; }

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = fileURLToPath(new URL('../src-tauri/icon-source.png', import.meta.url));
await writeFile(out, png);
console.log(`Wrote ${out} (${FRAME}, ${usedW}x${usedH} cells at ${cell}px, ${png.length} bytes)`);

// Renders the README artwork straight from the sprite sheet, so the docs can
// never drift away from what the app actually draws. Run `npm run showcase`.
//
// Output: docs/*.gif (one per clip) and docs/poses.png (one frame per clip).
//
// Zero dependencies. The GIFs use the "uncompressed LZW" form: every pixel is
// emitted as a literal and a clear code is sent before the dictionary would
// force a wider code. That is a few percent larger than real LZW and avoids
// the off-by-one in code-size growth that silently corrupts hand-rolled
// encoders. At this size it does not matter.
import { deflateSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCALE = 8;
const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));

// index 0 is transparent; the ground shadow is dropped because GIF has no
// partial alpha and a solid one looks like a plinth.
const PALETTE = [
  [0, 0, 0],          // 0 transparent
  [0xee, 0x6a, 0x4d], // 1 o  body
  [0xcd, 0x58, 0x3c], // 2 d  shade
  [0x1a, 0x1a, 0x1a], // 3 e  eye
  [0x8e, 0xc9, 0xf0], // 4 t  tear
  [0x3f, 0x3f, 0x3c], // 5 k  laptop
  [0x9f, 0xd4, 0xcd], // 6 g  screen glow
  [0xd8, 0xf2, 0xee], // 7 G  screen glow bright
  [0xf0, 0xee, 0xe6], // 8 p  paper
];
const INDEX = { o: 1, d: 2, e: 3, t: 4, k: 5, g: 6, G: 7, p: 8 };
const MIN_CODE_SIZE = 4;                 // 16 palette slots is plenty

// ── Sprite sheet ────────────────────────────────────────────────────────────
const src = await readFile(new URL('../src/frames.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const FRAMES = sandbox.window.CLAWD_FRAMES;
const { w: COLS, h: ROWS } = sandbox.window.CLAWD_GRID;

const W = COLS * SCALE;
const H = ROWS * SCALE;

function pixels(frameName) {
  const rows = FRAMES[frameName];
  if (!rows) throw new Error(`no frame ${frameName}`);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = rows[Math.floor(y / SCALE)] || '';
    for (let x = 0; x < W; x++) {
      out[y * W + x] = INDEX[row[Math.floor(x / SCALE)]] || 0;
    }
  }
  return out;
}

// ── GIF ─────────────────────────────────────────────────────────────────────
class Bits {
  constructor() { this.out = []; this.cur = 0; this.n = 0; }
  push(code, size) {
    for (let i = 0; i < size; i++) {
      this.cur |= ((code >> i) & 1) << this.n;
      if (++this.n === 8) { this.out.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  flush() { if (this.n) { this.out.push(this.cur); this.cur = 0; this.n = 0; } }
}

function encodeLiteral(indices) {
  const clear = 1 << MIN_CODE_SIZE;
  const end = clear + 1;
  const size = MIN_CODE_SIZE + 1;
  // Codes the decoder may add before it would need a wider code.
  const run = (1 << MIN_CODE_SIZE) - 2;
  const bits = new Bits();
  bits.push(clear, size);
  let since = 0;
  for (const v of indices) {
    if (since === run) { bits.push(clear, size); since = 0; }
    bits.push(v, size);
    since++;
  }
  bits.push(end, size);
  bits.flush();
  return bits.out;
}

function subBlocks(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.slice(i, i + 255);
    parts.push(Buffer.from([slice.length]), Buffer.from(slice));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function gif(frameNames, delayCs) {
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'));

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(W, 0);
  lsd.writeUInt16LE(H, 2);
  lsd[4] = 0xf0 | (MIN_CODE_SIZE - 1);  // global colour table, 2^4 entries
  lsd[5] = 0;
  lsd[6] = 0;
  parts.push(lsd);

  const table = Buffer.alloc(3 * (1 << MIN_CODE_SIZE));
  PALETTE.forEach(([r, g, b], i) => { table[i * 3] = r; table[i * 3 + 1] = g; table[i * 3 + 2] = b; });
  parts.push(table);

  // loop forever
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'),
             Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  for (const name of frameNames) {
    const gce = Buffer.alloc(8);
    gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 4;
    gce[3] = 0x09;                    // restore to background + transparency on
    gce.writeUInt16LE(delayCs, 4);
    gce[6] = 0;                       // transparent index
    gce[7] = 0;
    parts.push(gce);

    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(0, 1); id.writeUInt16LE(0, 3);
    id.writeUInt16LE(W, 5); id.writeUInt16LE(H, 7);
    id[9] = 0;
    parts.push(id);

    parts.push(Buffer.from([MIN_CODE_SIZE]));
    parts.push(subBlocks(encodeLiteral(pixels(name))));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const seq = (name, n) => Array.from({ length: n }, (_, i) => `${name}_${i + 1}`);

// ── PNG (for the static pose sheet) ─────────────────────────────────────────
function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const TBL = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = TBL[(c ^ b[i]) & 0xff] ^ (c >>> 8); return c ^ 0xffffffff; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Build ───────────────────────────────────────────────────────────────────
await mkdir(DOCS, { recursive: true });

const CLIPS = [
  ['idle', seq('idle', 10), 16],
  ['work-laptop', seq('work_laptop', 8), 14],
  ['work-files', seq('work_files', 8), 12],
  ['work-write', seq('work_write', 6), 11],
  ['sit', seq('sit', 4), 50],
  ['cry', seq('cry', 8), 16],
  ['drag', seq('drag', 6), 11],
  ['tired', seq('tired', 5), 33],
];

for (const [name, frames, delay] of CLIPS) {
  const buf = gif(frames, delay);
  await writeFile(`${DOCS}${name}.gif`, buf);
  console.log(`docs/${name}.gif  ${frames.length} frames  ${(buf.length / 1024).toFixed(1)} KB`);
}

// One frame per clip, laid out in a grid.
const POSES = ['idle_1', 'blink_3', 'look_2', 'stretch_3', 'wiggle_2', 'walk_2',
               'work_write_1', 'work_think_4', 'work_process_2', 'work_laptop_5',
               'work_files_4', 'done_3', 'hover_2', 'click_2', 'drag_2',
               'tired_1', 'sit_1', 'cry_5'];
const PAD = 4;
const cellW = COLS * SCALE + PAD * 2;
const cellH = ROWS * SCALE + PAD * 2;
const gridCols = 6;
const gridRows = Math.ceil(POSES.length / gridCols);
const sheetW = cellW * gridCols;
const sheetH = cellH * gridRows;
const rgba = Buffer.alloc(sheetW * sheetH * 4);
POSES.forEach((name, i) => {
  const px = pixels(name);
  const ox = (i % gridCols) * cellW + PAD;
  const oy = Math.floor(i / gridCols) * cellH + PAD;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = px[y * W + x];
      if (!idx) continue;
      const [r, g, b] = PALETTE[idx];
      const o = ((oy + y) * sheetW + ox + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
});
const sheet = png(sheetW, sheetH, rgba);
await writeFile(`${DOCS}poses.png`, sheet);
console.log(`docs/poses.png  ${POSES.length} poses  ${(sheet.length / 1024).toFixed(1)} KB`);

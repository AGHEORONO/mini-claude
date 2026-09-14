// Rebuilds src/frames.js from the reference art in ref/frames/*.png.
//
// Each PNG is an 11x10 grid of 20px cells; the pixel at the centre of a cell
// decides what that cell is. Run `npm run frames` after changing the art.
//
//   ' ' empty   o body   d body shade   e eye   t tear
//   k laptop     g screen glow   G screen glow bright   p paper
//   x ground shadow
//
// The only thing added on top of the reference art is one shade tone along the
// bottom and right edge of the body. A previous attempt at full procedural
// relighting (eight tones from neighbour occupancy) was rejected: on this
// silhouette it read as a gargoyle rather than a mascot. Keep it at one tone.

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRAMES_DIR = join(ROOT, 'ref', 'frames');
const OUT = join(ROOT, 'src', 'frames.js');

const COLS = 11, ROWS = 10, SCALE = 20;
const HALF = SCALE / 2;

// Alpha is checked first so the shadow (dark but translucent) is not mistaken
// for the eyes (also dark, but opaque).
function classify(r, g, b, a) {
  if (a < 15) return ' ';
  if (a < 100) return 'x';
  const near = (v, t) => Math.abs(v - t) < 45;
  if (near(r, 238) && near(g, 106) && near(b, 77)) return 'o';
  if (near(r, 26) && near(g, 26) && near(b, 26)) return 'e';
  return 0.299 * r + 0.587 * g + 0.114 * b < 80 ? 'e' : 'o';
}

function extractRows(png) {
  const out = [];
  for (let row = 0; row < ROWS; row++) {
    let line = '';
    for (let col = 0; col < COLS; col++) {
      const x = Math.round(col * SCALE + HALF);
      const y = Math.round(row * SCALE + HALF);
      const i = (y * png.width + x) * 4;
      line += classify(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3] ?? 255);
    }
    out.push(line);
  }
  return out;
}

// Light comes from the left, so a body pixel darkens when its right-hand
// neighbour is open, or when it is the underside of a limb (nothing below it
// or either side of below). That second condition is what keeps the narrow
// gaps between the legs from turning into a dotted line of shade.
function shade(rows) {
  const grid = rows.map((r) => r.split(''));
  const body = (r, c) =>
    r >= 0 && r < ROWS && c >= 0 && c < COLS && 'oetkgGp'.includes(grid[r][c]);

  const out = rows.map((r) => r.split(''));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== 'o') continue;
      // `body(r, c - 1)` keeps the 1px-wide legs out of the edge rule: every
      // pixel of a leg has open space to its right, and shading all of them
      // turns the legs black.
      const rightEdge = !body(r, c + 1) && body(r, c - 1);
      const underside = !body(r + 1, c) && !body(r + 1, c - 1) && !body(r + 1, c + 1);
      if (rightEdge || underside) out[r][c] = 'd';
    }
  }
  return out.map((r) => r.join(''));
}

const raw = {};
for (const file of readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.png'))) {
  const png = PNG.sync.read(readFileSync(join(FRAMES_DIR, file)));
  raw[file.replace('.png', '')] = extractRows(png);
}

// ── Poses the reference art does not have ───────────────────────────────────
// Both are derived from existing frames rather than drawn, which keeps them in
// step with the art automatically.

const patch = (name, edit) => {
  const grid = raw[name].map((r) => r.split(''));
  edit(grid);
  return grid.map((r) => r.join(''));
};

// Sitting: the lower leg row is tucked away, leaving a squat.
if (raw.idle_1 && raw.idle_6) {
  const tuck = (g) => { g[8] = g[8].map((ch) => (ch === 'o' ? ' ' : ch)); };
  raw.sit_1 = patch('idle_1', tuck);
  raw.sit_2 = patch('idle_1', tuck);
  raw.sit_3 = patch('idle_6', tuck);   // idle_6 is the blink frame
  raw.sit_4 = patch('idle_1', tuck);
}

// Crying: the sleepy pose with tears running from under each eye (columns 3
// and 7) down the face and off into the gaps between the legs.
if (raw.tired_1) {
  const DRIPS = [
    [[4, 3]],
    [[5, 3], [4, 7]],
    [[6, 3], [5, 7]],
    [[7, 3], [6, 7], [4, 3]],
    [[8, 3], [7, 7], [5, 3]],
    [[8, 7], [6, 3], [4, 7]],
    [[7, 3], [5, 7]],
    [[8, 3], [6, 7]],
  ];
  DRIPS.forEach((tears, i) => {
    raw[`cry_${i + 1}`] = patch('tired_1', (g) => {
      for (const [r, c] of tears) g[r][c] = 't';
    });
  });
}

// Digging a laptop out and typing on it. The lid covers the legs, which is
// exactly what reads as "sitting behind a desk".
if (raw.work_write_1) {
  const base = (i) => `work_write_${(i % 6) + 1}`;
  const lid = (g, bright) => {
    for (let c = 2; c <= 8; c++) {
      g[7][c] = bright && (c === 2 || c === 8) ? 'G' : 'g';
      g[8][c] = 'k';
    }
  };
  const steps = [
    null,                                   // still empty-handed
    null,
    (g) => { for (let c = 3; c <= 7; c++) g[8][c] = 'k'; },   // hauling it up
    (g) => lid(g, false),
    (g) => lid(g, true),
    (g) => lid(g, false),
    (g) => lid(g, true),
    (g) => lid(g, false),
  ];
  steps.forEach((edit, i) => {
    raw[`work_laptop_${i + 1}`] = patch(base(i), (g) => { if (edit) edit(g); });
  });
}

// Rummaging through files: loose pages thrown up on either side of him.
if (raw.work_process_1) {
  // Pages stay in the four corner columns the head never occupies, so they
  // read as loose sheets rather than as something growing out of him.
  const PAGES = [
    [[1, 0], [1, 1]],
    [[0, 0], [0, 1]],
    [[0, 1], [1, 9], [1, 10]],
    [[0, 9], [0, 10]],
    [[1, 0], [1, 1], [0, 10]],
    [[0, 0], [0, 1], [0, 9]],
    [[1, 9], [1, 10]],
    [[0, 10]],
  ];
  PAGES.forEach((sheets, i) => {
    raw[`work_files_${i + 1}`] = patch(`work_process_${(i % 6) + 1}`, (g) => {
      for (const [r, c] of sheets) g[r][c] = 'p';
    });
  });
}

const result = {};
for (const [name, rows] of Object.entries(raw)) result[name] = shade(rows);

writeFileSync(
  OUT,
  `// Auto-generated by tools/extract-frames.mjs - edit ref/frames/*.png, not here.\n` +
  `window.CLAWD_GRID={w:${COLS},h:${ROWS}};\n` +
  `window.CLAWD_FRAMES=${JSON.stringify(result)};\n`,
);
console.log(`Extracted ${Object.keys(result).length} frames (${COLS}x${ROWS}) -> src/frames.js`);

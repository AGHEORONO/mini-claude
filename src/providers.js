// Every AI CLI the pet can watch: its character, and the skins it can wear.
//
// Claude is Clawd, drawn from the reference sheet. Every other tool has its
// own resting sprite (`sprite.rows`, 11x9 on the same grid) and borrows each
// pose from the matching Clawd frame -- see compose() in pixel.js. Characters
// follow what each tool is known for, without copying any logo:
//   Codex    -- a little cloud with a `_` prompt for a mouth (its icon is a
//               cloud holding a terminal prompt)
//   Gemini   -- the four-point sparkle
//   Qwen     -- a capybara in a white T-shirt, Qwen's own mascot
//   opencode -- a monochrome block bot with a screen for a face and a cursor
//   Copilot  -- a pilot in flying goggles, after its CLI welcome art
//
// Sprite characters: o body, d shade, e eye, plus a/b/w/W, coloured per skin.
// `socket` lists what an eye may glance across (default: the body).
// A skin may add one treatment (grad, scan, band, outline; see paint()).
// `lid` is the colour of a shut eye.
//
// `accent` themes the panel title and pressed buttons and must keep 4.5:1
// against the cream panel (#f0eee6). `bars` are the fill colours, in order;
// each fill ends in an ink edge, which is what carries the 3:1 contrast.

export const PROVIDERS = [
  {
    id: 'claude', name: 'Claude', cli: 'Claude Code',
    accent: '#a84a2a',
    bars: ['#d97757', '#a86a3e', '#8c6bd9'],
    sprite: null,
    skins: [
      { id: 'classic',  name: 'Classic',  body: '#ee6a4d', shade: '#cd583c', eye: '#1a1a1a' },
      { id: 'midnight', name: 'Midnight', body: '#3a3633', shade: '#262321', eye: '#ff8a65' },
      { id: 'ghost',    name: 'Ghost',    body: '#f0eee6', shade: '#cfcabb', eye: '#3d3d3a', outline: '#8a8676' },
      { id: 'sakura',   name: 'Sakura',   body: '#f4a7b9', shade: '#d9849a', eye: '#3d2a30' },
      { id: 'gold',     name: 'Gold',     body: '#e8b04a', shade: '#c48f2e', eye: '#3a2a10' },
    ],
  },
  {
    id: 'codex', name: 'Codex', cli: 'Codex',
    accent: '#0f7a5f',
    bars: ['#10a37f', '#4b5563'],
    sprite: {
      rows: [
        '           ',
        '  ooo ooo  ',
        ' ooooooooo ',
        'ooooooooood',
        'oooeoooeood',
        'ooooooooood',
        ' oooaaaodd ',
        '  oo   od  ',
        '  dd   dd  ',
      ],
    },
    skins: [
      { id: 'cloud',    name: 'Cloud',    body: '#f4f6fb', shade: '#c4cbd9', eye: '#1f2330', lid: '#6b7385', a: '#10a37f', outline: '#9aa3b5' },
      { id: 'terminal', name: 'Terminal', body: '#2a2b2f', shade: '#16171a', eye: '#3ee08f', lid: '#1d6e4a', a: '#3ee08f', scan: '#34363b' },
      { id: 'storm',    name: 'Storm',    body: '#6b7280', shade: '#4b5563', eye: '#f9fafb', lid: '#374151', a: '#fde047' },
      { id: 'dawn',     name: 'Dawn',     body: '#ffd2c2', shade: '#e8a99a', eye: '#3a2a2a', lid: '#b07a6c', a: '#e0573a',
        grad: ['#ffe3d6', '#ffd2c2', '#ffbfae', '#f7a996'], gradShade: ['#efb9a8', '#e8a99a', '#df9887', '#d48874'] },
    ],
  },
  {
    id: 'gemini', name: 'Gemini', cli: 'Gemini CLI',
    accent: '#3559b8',
    bars: ['#4f8df5', '#a46bc9'],
    sprite: {
      rows: [
        '           ',
        '     o     ',
        '     o     ',
        '    ooo    ',
        '  oeoooed  ',
        'ooooooooood',
        '  ooooood  ',
        '    ood    ',
        '     d     ',
      ],
    },
    skins: [
      { id: 'aurora', name: 'Aurora', body: '#7b74e0', shade: '#5b55b8', eye: '#0e1a3a', lid: '#2a3270',
        grad: ['#4f8df5', '#5f88f0', '#7b7ee4', '#9a6fd4', '#bf6ea8', '#d4708a', '#e07a85'],
        gradShade: ['#3a6dd0', '#4568c8', '#5d5fbc', '#7853b0', '#9a508a', '#b0566e', '#bb5f69'] },
      { id: 'twilight', name: 'Twilight', body: '#3b3f8f', shade: '#2a2d6b', eye: '#ffd76a', lid: '#b39540',
        grad: ['#2f3c8f', '#3a3c8f', '#4a3b8c', '#573a88', '#633983', '#6b387d'],
        gradShade: ['#212b6b', '#2a2b6b', '#352a69', '#3f2966', '#482961', '#4f285c'] },
      { id: 'sky',  name: 'Sky',  body: '#8ab4f8', shade: '#6a94d8', eye: '#1a2b4a', lid: '#3d5a8a' },
      { id: 'star', name: 'Star', body: '#ffd54a', shade: '#e0a820', eye: '#3a2a08', lid: '#9a7414' },
    ],
  },
  {
    id: 'qwen', name: 'Qwen', cli: 'Qwen Code',
    accent: '#4a45c4',
    bars: ['#615ced'],
    sprite: {
      rows: [
        '           ',
        '  o     o  ',
        ' ooooooood ',
        ' oeoooooed ',
        ' ooobbbood ',
        ' oobbbbbod ',
        ' wwwwwwwwW ',
        ' wwwwwwwwW ',
        '  oo   od  ',
      ],
    },
    skins: [
      { id: 'capy',   name: 'Capy',   body: '#b07a4f', shade: '#8a5c38', eye: '#2a1a10', lid: '#5e3d24', b: '#6b4428', w: '#f4f2ec', W: '#c9c5b8' },
      { id: 'choco',  name: 'Choco',  body: '#7a4f30', shade: '#5c3a22', eye: '#f5e6d3', lid: '#3d2616', b: '#4a2f1b', w: '#f4f2ec', W: '#c9c5b8' },
      { id: 'violet', name: 'Violet tee', body: '#b07a4f', shade: '#8a5c38', eye: '#2a1a10', lid: '#5e3d24', b: '#6b4428', w: '#615ced', W: '#4a45c4' },
      { id: 'snow',   name: 'Snow',   body: '#e8dccb', shade: '#c9b9a2', eye: '#2a1a10', lid: '#9a8a72', b: '#b8a284', w: '#615ced', W: '#4a45c4' },
    ],
  },
  {
    id: 'opencode', name: 'opencode', cli: 'opencode',
    accent: '#3d3d3a',
    bars: ['#595954'],
    sprite: {
      socket: 'a',
      rows: [
        '           ',
        '     a     ',
        ' ooooooood ',
        ' oaaaaaaad ',
        ' oaeaaaead ',
        ' oaaawaaad ',
        ' ooooooood ',
        '  oo   od  ',
        '  dd   dd  ',
      ],
    },
    skins: [
      { id: 'mono',  name: 'Mono',  body: '#e8e8e8', shade: '#b0b0b0', eye: '#f5f5f5', lid: '#6a6a6a', a: '#1c1c1c', w: '#f5f5f5' },
      { id: 'ink',   name: 'Ink',   body: '#2e2e2e', shade: '#181818', eye: '#e8e8e8', lid: '#5a5a5a', a: '#0a0a0a', w: '#e8e8e8' },
      { id: 'amber', name: 'Amber', body: '#3a2b12', shade: '#241a0a', eye: '#ffb000', lid: '#6b4a00', a: '#140e05', w: '#ffb000', scan: '#44331a' },
    ],
  },
  {
    id: 'copilot', name: 'Copilot', cli: 'Copilot CLI',
    accent: '#6e40c9',
    bars: ['#8957e5', '#3f7fd1', '#2f9e55'],
    sprite: {
      socket: 'w',
      rows: [
        '           ',
        '   ooooo   ',
        '  ooooood  ',
        ' aaaaaaaaa ',
        'aawewawewaa',
        ' aaaaaaaaa ',
        '  ooooood  ',
        '  oo   od  ',
        '  dd   dd  ',
      ],
    },
    skins: [
      { id: 'pilot',  name: 'Pilot',  body: '#8957e5', shade: '#6e40c9', eye: '#1b1530', lid: '#7d6bb0', a: '#1b1530', w: '#d9ccff' },
      { id: 'octo',   name: 'Octo',   body: '#3d444d', shade: '#24292f', eye: '#0d1117', lid: '#3a6aa8', a: '#0d1117', w: '#58a6ff' },
      { id: 'sprout', name: 'Sprout', body: '#3fb950', shade: '#2c8a3a', eye: '#0f2a16', lid: '#5c9a66', a: '#0f2a16', w: '#d6ffe0' },
    ],
  },
];

export const byId = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

export function skinOf(provider, skinId) {
  return provider.skins.find((s) => s.id === skinId) || provider.skins[0];
}

// ── Settings ────────────────────────────────────────────────────────────────
// Shared by every pet window: they are all the same origin, so localStorage is
// common ground, and a Tauri event tells the others to re-read it.

const KEY = 'miniClaude.settings';

export function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* corrupt or private mode */ }
  const pets = Array.isArray(s?.pets) ? s.pets.filter((id) => PROVIDERS.some((p) => p.id === id)) : [];
  return {
    // Kept in registry order, so window slots are stable.
    pets: pets.length ? PROVIDERS.map((p) => p.id).filter((id) => pets.includes(id)) : ['claude'],
    skins: s?.skins && typeof s.skins === 'object' ? s.skins : {},
  };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

// Pixel-art Clawd renderer.
//
// The sprite sheet comes from the reference art via tools/extract-frames.mjs
// and already carries its own (deliberately minimal) shading, so this file
// just maps characters to colours -- no procedural relighting. What it adds is
// a continuous motion track per clip: frames still step at the clip's own fps
// while a gentle
// CSS transform (bob, breathe, lean, small turn) runs between them, and the
// ground shadow reacts to the height. That in-between glide is what reads as
// fluid without touching the art.
//
// One loop drives everything and stops dead when the window is hidden, motion
// is paused, or the user asked for reduced motion.
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const PX = 8;
  const GRID = window.CLAWD_GRID || { w: 11, h: 10 };
  const COLS = GRID.w;
  const ROWS = GRID.h;
  const F = window.CLAWD_FRAMES || {};

  // The reference palette, plus exactly one shade tone. Nothing else: an
  // eight-tone ramp was tried here and turned the mascot into a gargoyle.
  const COLORS = {
    o: '#ee6a4d',   // body
    d: '#cd583c',   // shade, on the right edge and under the legs
    e: '#1a1a1a',   // eye
    t: '#8ec9f0',   // tear
    k: '#3f3f3c',   // laptop
    g: '#9fd4cd',   // screen glow
    G: '#d8f2ee',   // screen glow, bright
    p: '#f0eee6',   // loose paper
  };
  const SHADOW = 'rgba(40, 25, 15, 0.9)';

  // ── Clips ─────────────────────────────────────────────────────────────────
  // `motion` returns the continuous transform, `t` in seconds since the clip
  // started. Amplitudes stay small on purpose: this is meant to read as the
  // reference art with some life in it, not as a different character.
  const seq = (name, n) => Array.from({ length: n }, (_, i) => `${name}_${i + 1}`);

  const ANIMS = {
    idle: {
      fps: 6, loop: true, frames: seq('idle', 10),
      motion: (t) => ({
        bob: Math.sin(t * 1.8) * 1.2,
        sy: 1 + Math.sin(t * 1.8) * 0.02,
        rotY: Math.sin(t * 0.5) * 4,
        rotX: Math.sin(t * 0.75) * 1.2,
      }),
    },
    blink: {
      fps: 12, loop: false, frames: seq('blink', 4), then: 'idle',
      motion: (t) => ({ bob: Math.sin(t * 1.8) * 1.1 }),
    },
    look: {
      // The art shifts the pupils; the transform turns the whole body with
      // them so the two read as one movement.
      fps: 4, loop: false, frames: seq('look', 6), then: 'idle',
      motion: (t) => ({ rotY: Math.sin(t * 2) * 15, bob: Math.sin(t * 1.8) * 0.8 }),
    },
    stretch: {
      fps: 5, loop: false, frames: seq('stretch', 7), then: 'idle',
      motion: (t) => {
        const ease = Math.sin(Math.min(1, t / 0.7) * Math.PI);
        return { bob: -4.5 * ease, sy: 1 + 0.11 * ease, sx: 1 - 0.06 * ease, rotX: -6 * ease };
      },
    },
    scratch: {
      fps: 6, loop: false, frames: seq('scratch', 6), then: 'idle',
      motion: (t) => ({ rot: Math.sin(t * 12) * 2.5, bob: Math.sin(t * 6) * 0.9 }),
    },
    wiggle: {
      fps: 14, loop: false, frames: seq('wiggle', 6), then: 'idle',
      motion: (t) => ({ rot: Math.sin(t * 16) * 5, rotY: Math.sin(t * 16) * 8 }),
    },
    walk: {
      // On the spot: looping forever would never hand back to idle, and a pet
      // that wanders across an always-on-top window is a nuisance.
      fps: 8, loop: false, then: 'idle',
      frames: [...seq('walk', 4), ...seq('walk', 4), ...seq('walk', 4)],
      motion: (t) => ({
        bob: -Math.abs(Math.sin(t * 6)) * 2.6,
        rot: Math.sin(t * 6) * 3.5,
        sy: 1 + Math.abs(Math.sin(t * 6)) * 0.035,
      }),
    },
    drag: {
      // Lifted well clear of the ground, swinging, and pushed toward the
      // viewer -- the shadow shrinking underneath does the rest.
      fps: 9, loop: true, frames: seq('drag', 6),
      motion: (t) => ({
        rot: Math.sin(t * 4.2) * 13,
        bob: -7 + Math.sin(t * 4.2) * 2.2,
        rotY: Math.sin(t * 2.1) * 15,
        sx: 1.04, sy: 1.04, z: 26,
      }),
    },
    work_think: {
      fps: 6, loop: true, frames: seq('work_think', 8),
      motion: (t) => ({ rotX: 5 + Math.sin(t * 1.4) * 2.5, rotY: Math.sin(t * 0.9) * 6, bob: Math.sin(t * 2.4) * 0.9 }),
    },
    work_write: {
      fps: 9, loop: true, frames: seq('work_write', 6),
      motion: (t) => ({ rotX: 8, bob: -Math.abs(Math.sin(t * 7)) * 1.2, sy: 1 - Math.abs(Math.sin(t * 7)) * 0.02 }),
    },
    work_process: {
      fps: 8, loop: true, frames: seq('work_process', 6),
      motion: (t) => ({ rotY: Math.sin(t * 1.6) * 12, bob: Math.sin(t * 3) * 1.2 }),
    },
    work_laptop: {
      // Hauls a laptop up out of shot, then settles in behind it. The lean
      // deepens as the lid comes up, so the two halves read as one move.
      fps: 7, loop: true, frames: seq('work_laptop', 8),
      motion: (t) => {
        const settled = Math.min(1, t / 1.1);
        return {
          rotX: 3 + settled * 7,
          bob: 1.5 - settled * 1.5 - Math.abs(Math.sin(t * 7)) * settled,
          sy: 1 - settled * 0.015,
        };
      },
    },
    work_files: {
      // Digging through papers: quick, slightly frantic, never still.
      fps: 8, loop: true, frames: seq('work_files', 8),
      motion: (t) => ({
        rot: Math.sin(t * 8.5) * 3,
        rotY: Math.sin(t * 3.3) * 13,
        bob: Math.sin(t * 9) * 1.3,
        rotX: 4,
      }),
    },
    done: {
      fps: 10, loop: false, frames: seq('done', 8), then: 'idle',
      motion: (t) => {
        const hop = Math.max(0, Math.sin(t * 4.4));
        return { bob: -8 * hop, sy: 1 + 0.09 * hop, sx: 1 - 0.05 * hop, rotY: Math.sin(t * 5) * 10, z: 16 * hop };
      },
    },
    error: {
      fps: 12, loop: false, frames: seq('error', 6), then: 'idle',
      motion: (t) => ({ rot: Math.sin(t * 22) * 4 * Math.exp(-t * 1.4), sx: 1 + Math.sin(t * 22) * 0.03 }),
    },
    tired: {
      // Doubles as the dozing-off pose after a long quiet spell.
      fps: 3, loop: true, frames: seq('tired', 5),
      motion: (t) => ({ bob: 1.6 + Math.sin(t * 0.85) * 1.4, rotX: -6, sy: 0.96, sx: 1.03, rot: Math.sin(t * 0.45) * 1.5 }),
    },
    hover: {
      fps: 10, loop: false, frames: seq('hover', 4), then: 'idle',
      motion: (t) => ({ bob: -3.5 * Math.sin(Math.min(1, t / 0.4) * Math.PI), rotY: Math.sin(t * 6) * 7, z: 10 }),
    },
    click: {
      // Squash on impact, then a damped overshoot on the way back.
      fps: 12, loop: false, frames: seq('click', 5), then: 'idle',
      motion: (t) => {
        const k = Math.exp(-t * 7) * Math.cos(t * 18);
        return { sy: 1 - 0.14 * k, sx: 1 + 0.11 * k, bob: 4.5 * k };
      },
    },

    // Two extra fidgets built from frames the sheet already has, so the pet
    // repeats itself less without any new art.
    nod: {
      fps: 6, loop: false, frames: seq('idle', 6), then: 'idle',
      motion: (t) => ({ rotX: Math.sin(t * 7) * 14 * Math.exp(-t * 1.4), bob: Math.sin(t * 7) * 1.4 * Math.exp(-t * 1.4) }),
    },
    peek: {
      fps: 5, loop: false, frames: seq('look', 6), then: 'idle',
      motion: (t) => {
        const ease = Math.sin(Math.min(1, t / 1.1) * Math.PI);
        return { rotY: 22 * ease, rot: 3 * ease };
      },
    },

    // Extra idle fidgets. All of them reuse frames the sheet already has and
    // get their character from the motion track alone.
    sway: {
      fps: 4, loop: false, frames: seq('idle', 8), then: 'idle',
      motion: (t) => ({ rot: Math.sin(t * 1.6) * 4, rotY: Math.sin(t * 1.6) * 9, bob: Math.sin(t * 3.2) * 0.7 }),
    },
    bounce: {
      fps: 8, loop: false, frames: seq('idle', 8), then: 'idle',
      motion: (t) => {
        const hop = Math.abs(Math.sin(t * 5)) * Math.exp(-t * 1.1);
        return { bob: -7 * hop, sy: 1 + 0.07 * hop, sx: 1 - 0.04 * hop };
      },
    },
    shiver: {
      fps: 14, loop: false, frames: seq('idle', 6), then: 'idle',
      motion: (t) => {
        const d = Math.exp(-t * 2.2);
        return { rot: Math.sin(t * 34) * 2.2 * d, sx: 1 + Math.sin(t * 30) * 0.02 * d };
      },
    },
    ponder: {
      // Borrows the thinking frames while nothing is actually running.
      fps: 5, loop: false, frames: seq('work_think', 8), then: 'idle',
      motion: (t) => ({ rotX: -5, rotY: Math.sin(t * 1.1) * 10, bob: Math.sin(t * 2) * 0.9 }),
    },
    yawn: {
      // The sleepy frames played once, with a big stretch through the middle.
      fps: 4, loop: false, frames: seq('tired', 5), then: 'idle',
      motion: (t) => {
        const ease = Math.sin(Math.min(1, t / 1.1) * Math.PI);
        return { bob: -5 * ease, sy: 1 + 0.12 * ease, sx: 1 - 0.05 * ease, rotX: -8 * ease };
      },
    },
    // Told to sit. Loops, which also means no fidget ever fires.
    sit: {
      fps: 2, loop: true, frames: seq('sit', 4),
      motion: (t) => ({ bob: 2 + Math.sin(t * 1.2) * 0.7, sy: 0.985, sx: 1.015 }),
    },
    // Left sitting for too long. Shuffles off to the side, turns half away and
    // sobs; the tears are in the frames, the shudder is here.
    cry: {
      fps: 6, loop: true, frames: seq('cry', 8),
      motion: (t) => {
        const sob = Math.abs(Math.sin(t * 3.1));
        return {
          tx: -10, rotY: -20, rotX: -9,
          bob: 2.5 + sob * 1.8,
          sy: 0.97 - sob * 0.02,
          rot: Math.sin(t * 6.4) * 1.8 * sob,
        };
      },
    },

    tilt: {
      fps: 5, loop: false, frames: seq('look', 6), then: 'idle',
      motion: (t) => {
        const ease = Math.sin(Math.min(1, t / 1.2) * Math.PI);
        return { rot: 11 * ease, rotY: 8 * ease };
      },
    },
  };

  const REST = { tx: 0, bob: 0, rot: 0, rotX: 0, rotY: 0, sx: 1, sy: 1, z: 0 };

  // Blink is weighted high so it fires most often.
  const FIDGETS = [
    'blink', 'blink', 'blink', 'blink', 'blink',
    'look', 'nod', 'peek', 'tilt', 'sway',
    'scratch', 'stretch', 'wiggle', 'walk',
    'bounce', 'shiver', 'ponder', 'yawn',
  ];

  // ── Motion preferences ────────────────────────────────────────────────────
  const MQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(MQ && MQ.matches);
  let paused = false;

  // ── Element pool ──────────────────────────────────────────────────────────
  // Rects are created once and only changed fills are written, so a frame
  // costs a handful of attribute writes instead of a few hundred allocations.
  let bodySvg, shadowSvg;
  const cells = new Array(COLS * ROWS).fill(null);
  const cellFill = new Array(COLS * ROWS).fill(null);
  const shadowCells = new Array(COLS * ROWS).fill(null);
  const shadowOn = new Array(COLS * ROWS).fill(false);

  let curAnim = 'idle';
  let curFrame = 0;
  let clipStart = 0;
  let frameAcc = 0;
  let lastTs = 0;
  let rafId = 0;
  let timerId = 0;
  let fidgetAt = 0;
  // Where the current one-shot clip hands back to. Without this every clip
  // would return to idle, and a pet that was told to sit would stand up again
  // the first time you clicked it.
  let restAfter = null;

  function mkRect(parent, x, y, fill, opacity) {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x * PX);
    r.setAttribute('y', y * PX);
    r.setAttribute('width', PX);
    r.setAttribute('height', PX);
    r.setAttribute('fill', fill);
    if (opacity != null) r.setAttribute('opacity', opacity);
    r.style.display = 'none';
    parent.appendChild(r);
    return r;
  }

  function renderFrame(name) {
    const rows = F[name];
    if (!rows) return;
    for (let y = 0; y < ROWS; y++) {
      const row = rows[y] || '';
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        const ch = row[x];

        const shadow = ch === 'x';
        if (shadow !== shadowOn[i]) {
          shadowOn[i] = shadow;
          shadowCells[i].style.display = shadow ? '' : 'none';
        }

        const fill = shadow ? null : (COLORS[ch] || null);
        if (fill === cellFill[i]) continue;
        cellFill[i] = fill;
        if (fill === null) {
          cells[i].style.display = 'none';
        } else {
          cells[i].setAttribute('fill', fill);
          cells[i].style.display = '';
        }
      }
    }
  }

  // ── Transform ─────────────────────────────────────────────────────────────
  let lastTransform = '';
  let lastShadow = '';

  function applyMotion(m) {
    const sx = m.sx == null ? 1 : m.sx;
    const sy = m.sy == null ? 1 : m.sy;
    const bob = m.bob || 0;
    const t =
      `translate3d(${(m.tx || 0).toFixed(2)}px, ${bob.toFixed(2)}px, ${(m.z || 0).toFixed(2)}px)` +
      ` rotateX(${(m.rotX || 0).toFixed(2)}deg)` +
      ` rotateY(${(m.rotY || 0).toFixed(2)}deg)` +
      ` rotate(${(m.rot || 0).toFixed(2)}deg)` +
      ` scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    // A style write on an unchanged value still costs a recomposite.
    if (t !== lastTransform) { lastTransform = t; bodySvg.style.transform = t; }

    // Higher body -> smaller, fainter shadow. That is the cue that makes a bob
    // read as leaving the ground rather than sliding up a wall.
    const lift = Math.max(0, -bob) / 12;
    const s = `scale(${(1 - lift * 0.25).toFixed(3)}, 1)`;
    if (s !== lastShadow) {
      lastShadow = s;
      shadowSvg.style.transform = s;
      shadowSvg.style.opacity = (1 - lift * 0.4).toFixed(3);
    }
  }

  // ── Loop ──────────────────────────────────────────────────────────────────
  function step(ts) {
    rafId = 0;
    const anim = ANIMS[curAnim] || ANIMS.idle;
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;

    frameAcc += dt;
    const interval = 1 / anim.fps;
    let advanced = false;
    while (frameAcc >= interval) {
      frameAcc -= interval;
      curFrame++;
      advanced = true;
      if (curFrame >= anim.frames.length) {
        if (anim.loop) {
          curFrame = 0;
        } else {
          const next = restAfter || anim.then || 'idle';
          restAfter = null;
          play(next);
          return;
        }
      }
    }
    if (advanced) renderFrame(anim.frames[curFrame]);

    applyMotion(anim.motion ? Object.assign({}, REST, anim.motion((ts - clipStart) / 1000)) : REST);

    if (curAnim === 'idle' && ts >= fidgetAt) {
      play(FIDGETS[Math.floor(Math.random() * FIDGETS.length)]);
      return;
    }
    schedule();
  }

  // A desktop pet has no business running a 60 Hz loop. Each clip gets the
  // slowest update rate its own motion can survive, which is what keeps the
  // idle app down at a fraction of a core.
  function motionInterval() {
    const anim = ANIMS[curAnim] || ANIMS.idle;
    return 1000 / Math.max(24, Math.min(40, anim.fps * 3));
  }

  function schedule() {
    if (rafId || timerId || reduced || paused || document.hidden) return;
    // setTimeout picks the cadence, rAF still aligns the paint to a vsync.
    timerId = setTimeout(() => {
      timerId = 0;
      rafId = requestAnimationFrame(step);
    }, motionInterval());
  }

  function stop() {
    clearTimeout(timerId);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    timerId = 0;
    lastTs = 0;
  }

  function freeze() {
    stop();
    // Frame 0 of a clip like drag or click is mid-action; idle_1 is the only
    // pose that looks deliberate when held still.
    renderFrame(F.idle_1 ? 'idle_1' : (ANIMS[curAnim] || ANIMS.idle).frames[0]);
    applyMotion(REST);
  }

  function play(name, then) {
    if (!ANIMS[name]) name = 'idle';
    const anim = ANIMS[name];
    restAfter = then && ANIMS[then] ? then : null;
    curAnim = name;
    curFrame = 0;
    frameAcc = 0;
    lastTs = 0;
    clipStart = performance.now();
    if (name === 'idle') fidgetAt = clipStart + 3500 + Math.random() * 7000;
    if (reduced || paused) { freeze(); return; }
    // Draw frame 0 now rather than waiting for the first tick, so switching
    // clips never shows an empty sprite.
    renderFrame(anim.frames[0]);
    applyMotion(anim.motion ? Object.assign({}, REST, anim.motion(0)) : REST);
    schedule();
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  function build() {
    const bodyG = document.getElementById('body');
    const shadowG = document.getElementById('charShadow');
    if (!bodyG || !shadowG) return;
    bodySvg = bodyG.ownerSVGElement;
    shadowSvg = shadowG.ownerSVGElement;

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        cells[i] = mkRect(bodyG, x, y, COLORS.o);
        shadowCells[i] = mkRect(shadowG, x, y, SHADOW, 0.16);
      }
    }
    play('idle');
  }

  if (MQ && MQ.addEventListener) {
    MQ.addEventListener('change', (e) => { reduced = e.matches; play(curAnim); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else play(curAnim);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  window.clawd = {
    play(name, then) { play(name, then); },
    idle() { play('idle'); },
    current() { return curAnim; },
    // User-facing motion switch, independent of prefers-reduced-motion, so a
    // looping mascot on an always-on-top window can always be stopped.
    setPaused(on) { paused = !!on; if (paused) freeze(); else play(curAnim); },
    isPaused() { return paused; },
  };
})();

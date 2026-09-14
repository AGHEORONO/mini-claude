// UI layer. Data comes from the Tauri backend when the native shell is
// running, otherwise from usage.json written by data/estimate.mjs, otherwise
// from demo values so the panel is never empty.

const TAURI = !!globalThis.__TAURI__;

const BAR_DEFS = [
  { id: '5h',   label: '5h Session',  color: 'var(--bar-5h)' },
  { id: 'week', label: 'Weekly',      color: 'var(--bar-week)' },
  { id: 'opus', label: 'Weekly Opus', color: 'var(--bar-opus)' },
];

// Picked at random whenever Claude Code starts writing, so a long session does
// not look like the same loop over and over.
const WORK_CLIPS = ['work_write', 'work_process', 'work_think', 'work_laptop', 'work_files'];

// Overwritten by the backend/config.json on boot.
let DANGER_PCT = 90;
// Not "getting close" but "there is nothing left", which is a different mood.
let EXHAUSTED_PCT = 99;
let POLL_MS = 300_000;
// Hysteresis: a bar hovering on the threshold must not re-announce every tick.
const RECOVER_MARGIN = 3;

async function invoke(cmd, args) {
  if (!TAURI) return null;
  try { return await globalThis.__TAURI__.core.invoke(cmd, args ?? {}); }
  catch { return null; }
}

// ── Data ────────────────────────────────────────────────────────────────────
function pctOf(used, limit) {
  if (!limit || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function normalize(raw) {
  const byId = Object.fromEntries((raw.limits || []).map(l => [l.id, l]));
  const limits = BAR_DEFS.map(def => {
    const l = byId[def.id] || {};
    const pct = l.pct != null ? l.pct : pctOf(l.used, l.limit);
    return {
      id: def.id,
      label: def.label,
      color: def.color,
      pct,
      resetsAt: l.resetsAt ?? null,
      available: pct != null,
    };
  });
  return {
    source: raw.source || 'estimate',
    updatedAt: raw.updatedAt || Date.now(),
    limits,
    danger: limits.some(l => l.pct != null && l.pct >= DANGER_PCT),
  };
}

function demoData() {
  const now = Date.now();
  return normalize({
    source: 'demo', updatedAt: now,
    limits: [
      { id: '5h',   used: 64, limit: 100, resetsAt: now + 2.5 * 3600e3 },
      { id: 'week', used: 41, limit: 100, resetsAt: now + 4 * 86400e3 },
      { id: 'opus', used: 78, limit: 100, resetsAt: now + 4 * 86400e3 },
    ],
  });
}

async function getUsage() {
  const native = await invoke('get_usage');
  if (native?.limits) return normalize(native);
  try {
    const res = await fetch('./usage.json', { cache: 'no-store' });
    if (res.ok) return normalize(await res.json());
  } catch { /* fall through to demo */ }
  return demoData();
}

async function loadConfig() {
  let cfg = await invoke('get_config');
  if (!cfg) {
    try {
      const res = await fetch('./config.json', { cache: 'no-store' });
      if (res.ok) cfg = await res.json();
    } catch { /* keep defaults */ }
  }
  if (Number.isFinite(cfg?.dangerPct)) DANGER_PCT = cfg.dangerPct;
  if (Number.isFinite(cfg?.exhaustedPct)) EXHAUSTED_PCT = cfg.exhaustedPct;
  if (Number.isFinite(cfg?.pollSeconds)) POLL_MS = Math.max(30, cfg.pollSeconds) * 1000;
}

function untilReset(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'reset now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `resets in ${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
  const d = Math.floor(h / 24), hr = h % 24;
  return hr ? `resets in ${d}d ${hr}h` : `resets in ${d}d`;
}

// ── DOM ─────────────────────────────────────────────────────────────────────
const pet          = document.getElementById('pet');
const character    = document.getElementById('character');
const dialog       = document.getElementById('dialog');
const barsEl       = document.getElementById('bars');
const sourceEl     = document.getElementById('source');
const liveEl       = document.getElementById('liveStatus');
const activityDot  = document.getElementById('activityDot');
const activityText = document.getElementById('activityText');
const menuEl       = document.getElementById('menu');
const tokensBtn    = document.getElementById('tokens');
const tokensLabel  = document.getElementById('tokensLabel');
const tokensValue  = document.getElementById('tokensValue');
const tokensNote   = document.getElementById('tokensNote');
const closeBtn     = document.getElementById('closeBtn');
const pinBtn       = document.getElementById('pinBtn');
const refreshBtn   = document.getElementById('refreshBtn');
const motionBtn    = document.getElementById('motionBtn');
const autostartBtn = document.getElementById('autostartBtn');

let pinned = false;
let lastData = null;
let pollTimer = null;
let wasTired = false;
let isWorking = false;
// Set when the user dismisses the panel, so a bar that is still over the
// threshold cannot force it back open on the next tick.
let suppressAutoOpen = false;
let announced = new Set();
let liveClearTimer = null;
let totals = null;
let tokensMode = 'month';

// Compact for the eye, exact for the screen reader.
function compact(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
const exact = (n) => (n == null ? 'unknown' : n.toLocaleString('en-GB'));

function renderTokens() {
  const month = tokensMode === 'month';
  const sum = totals && (month ? totals.month : totals.allTime);
  const period = month ? 'this month' : 'all time';
  const other = month ? 'all time' : 'this month';

  tokensLabel.textContent = `Tokens · ${period}`;
  tokensValue.textContent = sum ? compact(sum.total) : '—';
  tokensNote.textContent = sum
    // Cache reads dominate this number by two orders of magnitude, so showing
    // the split is the difference between a useful figure and a scary one.
    ? `in ${compact(sum.input)} · out ${compact(sum.output)} · cache ${compact(sum.cacheWrite + sum.cacheRead)}`
    : 'no local history';
  tokensBtn.setAttribute('aria-label', sum
    ? `Tokens ${period}: ${exact(sum.total)} across ${exact(sum.messages)} replies. Activate to show ${other}.`
    : 'Token totals unavailable. Activate to switch period.');
}

async function loadTotals() {
  totals = await invoke('get_totals');
  renderTokens();
}

tokensBtn.addEventListener('click', () => {
  tokensMode = tokensMode === 'month' ? 'all' : 'month';
  renderTokens();
  const sum = totals && (tokensMode === 'month' ? totals.month : totals.allTime);
  if (sum) {
    announce(`Tokens ${tokensMode === 'month' ? 'this month' : 'all time'}: ${exact(sum.total)}.`);
  }
});

// With nothing happening for a while he dozes off, and any sign of life wakes
// him. The reference sheet already has the sleepy pose, so this reuses it
// rather than inventing a new one.
const SLEEP_AFTER_MS = 4 * 60_000;
let sleepTimer = null;

// Told to sit via the right-click menu. Sitting outranks everything except
// being picked up: he was asked to stay put, so he stays put.
let sitting = false;
let cryTimer = null;
// Out of tokens. Unlike the sulk, this one is a fact about the world: no
// amount of petting makes it stop, only the limit resetting does.
let exhausted = false;

// The clip he settles back into once a one-shot animation finishes.
function restClip() {
  if (exhausted) return 'cry';
  if (sitting) return 'sit';
  if (wasTired) return 'tired';
  return 'idle';
}

function armSleep() {
  clearTimeout(sleepTimer);
  if (sitting) return;
  sleepTimer = setTimeout(() => {
    // Already working, or already slumped because usage is near the limit.
    if (isWorking || wasTired) { armSleep(); return; }
    window.clawd?.play('tired');
  }, SLEEP_AFTER_MS);
}

// Ignored on the naughty step for long enough and he starts crying. The delay
// is randomised so it never feels like a fixed alarm going off.
function armCry() {
  clearTimeout(cryTimer);
  if (!sitting) return;
  cryTimer = setTimeout(() => {
    if (sitting) window.clawd?.play('cry');
  }, (5 + Math.random() * 5) * 60_000);
}

function setSitting(on) {
  sitting = on;
  try { localStorage.setItem('miniClaude.sit', on ? '1' : '0'); } catch { /* private mode */ }
  clearTimeout(cryTimer);
  clearTimeout(sleepTimer);
  if (on) {
    window.clawd?.play('sit');
    armCry();
    announce('Mini Claude is sitting.');
  } else {
    window.clawd?.play('happy', 'idle');
    armSleep();
    announce('Mini Claude is up again.');
  }
}

function nudge() {
  // Nothing you can do for him until the limit resets.
  if (exhausted) return;
  const clip = window.clawd?.current();
  if (sitting) {
    // Any attention stops the crying and resets the clock.
    if (clip === 'cry') window.clawd?.play('happy', 'sit');
    armCry();
    return;
  }
  // Only wake him if he nodded off on his own; a near-limit slump must stay.
  if (!wasTired && clip === 'tired') window.clawd.idle();
  armSleep();
}

// ── Announcements ───────────────────────────────────────────────────────────
function announce(msg) {
  clearTimeout(liveClearTimer);
  // Blanking first guarantees an identical later message is still spoken.
  liveEl.textContent = '';
  requestAnimationFrame(() => {
    liveEl.textContent = msg;
    liveClearTimer = setTimeout(() => { liveEl.textContent = ''; }, 5000);
  });
}

function announceDanger(data) {
  const next = new Set();
  for (const l of data.limits) {
    if (l.pct == null) continue;
    if (l.pct >= DANGER_PCT) next.add(l.id);
    else if (l.pct > DANGER_PCT - RECOVER_MARGIN && announced.has(l.id)) next.add(l.id);
  }
  const crossed = data.limits.filter(l => next.has(l.id) && !announced.has(l.id));
  const hadAny = announced.size > 0;
  announced = next;

  if (crossed.length) {
    // A newly crossed threshold is new information, so it re-arms auto-open.
    suppressAutoOpen = false;
    announce(crossed.map(l => `${l.label} at ${l.pct} percent of the limit`).join('. ') + '.');
  } else if (hadAny && next.size === 0) {
    announce(`Usage back below ${DANGER_PCT} percent.`);
  }
}

// ── Panel ───────────────────────────────────────────────────────────────────
function setDialogOpen(open) {
  if (dialog.hidden === !open) return;
  // Must be read before hiding, or activeElement has already moved to body.
  const hadFocusInside = dialog.contains(document.activeElement);
  dialog.hidden = !open;
  character.setAttribute('aria-expanded', String(open));
  if (open) window.clawd?.play('done', restClip());
  else if (hadFocusInside) character.focus();
}

function dismiss() {
  pinned = false;
  pinBtn.setAttribute('aria-pressed', 'false');
  suppressAutoOpen = true;
  setDialogOpen(false);
}

// ── Bars ────────────────────────────────────────────────────────────────────
function buildBars() {
  if (barsEl.children.length) return;
  for (const def of BAR_DEFS) {
    const row = document.createElement('div');
    row.className = 'bar';
    row.dataset.id = def.id;

    const top = document.createElement('div');
    top.className = 'bar__top';
    // The visible label and value are duplicated inside the progressbar's
    // name and valuetext, so they are hidden from AT to avoid triple speech.
    const label = document.createElement('span');
    label.className = 'bar__label';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = def.label;
    const pct = document.createElement('span');
    pct.className = 'bar__pct';
    pct.setAttribute('aria-hidden', 'true');
    pct.textContent = '—';
    top.append(label, pct);

    const track = document.createElement('div');
    track.className = 'bar__track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', def.label);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('div');
    fill.className = 'bar__fill';
    fill.style.background = def.color;
    track.appendChild(fill);

    const reset = document.createElement('span');
    reset.className = 'bar__reset';
    reset.setAttribute('aria-hidden', 'true');

    row.append(top, track, reset);
    barsEl.appendChild(row);
  }
}

function renderData(data) {
  for (const l of data.limits) {
    const row = barsEl.querySelector(`.bar[data-id="${l.id}"]`);
    if (!row) continue;
    const fill = row.querySelector('.bar__fill');
    const pctEl = row.querySelector('.bar__pct');
    const track = row.querySelector('.bar__track');
    const resetEl = row.querySelector('.bar__reset');

    if (l.available) {
      const danger = l.pct >= DANGER_PCT;
      const reset = untilReset(l.resetsAt);
      fill.style.width = `${l.pct}%`;
      pctEl.textContent = `${l.pct}%`;
      resetEl.textContent = reset;
      track.setAttribute('aria-valuenow', String(l.pct));
      track.setAttribute('aria-valuetext',
        `${l.pct} percent${danger ? ', near limit' : ''}${reset ? ', ' + reset : ''}`);
      row.classList.toggle('is-danger', danger);
    } else {
      fill.style.width = '0%';
      pctEl.textContent = 'N/A';
      resetEl.textContent = 'no source';
      // Omitting aria-valuenow is how ARIA spells "indeterminate"; setting it
      // to 0 would claim a measured value of zero.
      track.removeAttribute('aria-valuenow');
      track.setAttribute('aria-valuetext', 'unavailable, no data source');
      row.classList.remove('is-danger');
    }
  }
  const srcLabel = { real: 'real data', estimate: 'estimated', demo: 'demo' }[data.source] || data.source;
  const time = new Date(data.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  sourceEl.dataset.text = `${srcLabel} · ${time}`;
  if (!sourceEl.dataset.tipShown) sourceEl.textContent = sourceEl.dataset.text;
}

function applyData(data, { show = false } = {}) {
  lastData = data;
  renderData(data);
  announceDanger(data);

  const empty = data.limits.some((l) => l.pct != null && l.pct >= EXHAUSTED_PCT);
  if (empty !== exhausted) {
    exhausted = empty;
    window.clawd?.play(empty ? 'cry' : restClip());
    const hit = data.limits.filter((l) => l.pct != null && l.pct >= EXHAUSTED_PCT);
    announce(empty
      ? `${hit.map((l) => l.label).join(' and ')} limit reached.`
      : 'Limits have reset.');
  }

  // `empty` is checked too, so a configuration where the exhausted threshold
  // sits below the danger one still surfaces the panel.
  if (data.danger || empty) {
    if (!suppressAutoOpen) setDialogOpen(true);
    if (!wasTired) {
      wasTired = true;
      if (!isWorking && !sitting && !exhausted) window.clawd?.play('tired');
    }
  } else {
    suppressAutoOpen = false;
    if (wasTired) {
      wasTired = false;
      if (!isWorking && !sitting && !exhausted) window.clawd?.idle();
    }
    if (show) setDialogOpen(true);
  }
}

async function refresh(opts) {
  applyData(await getUsage(), opts);
  loadTotals();
  schedulePoll();
}

// The watcher pushes updates in the native shell, so polling there would only
// duplicate work; it exists for the plain-browser fallback.
function schedulePoll() {
  if (TAURI) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => refresh(), POLL_MS);
}

// ── Native events ───────────────────────────────────────────────────────────
// The dot tracks live session writes, not whether the process exists -- that
// used to cost a `tasklist` spawn every 15s for strictly less information.
function setActivity(active) {
  activityDot.classList.toggle('is-active', active);
  activityText.textContent = active ? 'Claude Code working' : 'Claude Code idle';
}

async function listenNative() {
  if (!TAURI) { activityDot.hidden = true; activityText.hidden = true; return; }
  const { listen } = globalThis.__TAURI__.event;
  try {
    await listen('usage-updated', async () => {
      applyData(await getUsage());
      loadTotals();
    });
    await listen('claude-working', (e) => {
      const active = !!e.payload?.active;
      setActivity(active);
      if (active) {
        // Deliberately not nudge(): Claude Code running is not the user
        // paying attention to the pet, so it must not reset the cry timer.
        if (!isWorking && !sitting && !exhausted) {
          isWorking = true;
          // Working wins over every other state. It used to be gated behind
          // `!wasTired`, which meant that once usage crossed the danger line
          // the pet stayed slumped and never reacted to Claude Code again.
          window.clawd?.play(WORK_CLIPS[Math.floor(Math.random() * WORK_CLIPS.length)]);
        }
      } else if (isWorking) {
        isWorking = false;
        window.clawd?.play(restClip());
        armSleep();
      }
    });
  } catch { /* events are a nicety, the panel still works without them */ }
}

// ── Controls ────────────────────────────────────────────────────────────────
// Icon-only buttons need their meaning somewhere a keyboard or low-vision user
// can reach. The footer line doubles as the label strip: no overflow, and it
// appears on focus as well as hover.
function wireTips() {
  for (const btn of document.querySelectorAll('[data-tip]')) {
    const show = () => {
      sourceEl.dataset.tipShown = '1';
      sourceEl.textContent = btn.dataset.tip;
    };
    const hide = () => {
      delete sourceEl.dataset.tipShown;
      sourceEl.textContent = sourceEl.dataset.text || '';
    };
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('blur', hide);
  }
}

async function initAutostart() {
  if (!TAURI) { autostartBtn.hidden = true; return; }
  autostartBtn.setAttribute('aria-pressed', String(!!(await invoke('get_autostart'))));
}

function initMotionToggle() {
  const off = localStorage.getItem('miniClaude.motion') === 'off';
  if (off) window.clawd?.setPaused(true);
  motionBtn.setAttribute('aria-pressed', String(off));
  motionBtn.dataset.tip = off ? 'Resume animation' : 'Pause animation';
  motionBtn.setAttribute('aria-label', motionBtn.dataset.tip);
}

autostartBtn.addEventListener('click', async () => {
  const next = autostartBtn.getAttribute('aria-pressed') !== 'true';
  autostartBtn.setAttribute('aria-pressed', String(next));
  const ok = await invoke('set_autostart', { enabled: next });
  if (ok === null) {
    autostartBtn.setAttribute('aria-pressed', String(!next));
    window.clawd?.play('error', restClip());
    announce('Could not change the auto-start setting.');
  }
});

motionBtn.addEventListener('click', () => {
  const next = !window.clawd?.isPaused();
  window.clawd?.setPaused(next);
  try { localStorage.setItem('miniClaude.motion', next ? 'off' : 'on'); } catch { /* private mode */ }
  motionBtn.setAttribute('aria-pressed', String(next));
  motionBtn.dataset.tip = next ? 'Resume animation' : 'Pause animation';
  motionBtn.setAttribute('aria-label', motionBtn.dataset.tip);
  if (document.activeElement === motionBtn) sourceEl.textContent = motionBtn.dataset.tip;
});

closeBtn.addEventListener('click', dismiss);

pinBtn.addEventListener('click', () => {
  pinned = !pinned;
  pinBtn.setAttribute('aria-pressed', String(pinned));
  if (pinned) { suppressAutoOpen = false; setDialogOpen(true); }
});

refreshBtn.addEventListener('click', () => refresh());

character.addEventListener('click', () => {
  if (justDragged) return;
  nudge();
  window.clawd?.play('click', restClip());
  if (dialog.hidden) refresh({ show: true }); else dismiss();
});

// native.js owns the OS-level drag but not the pet's state, so it just says
// when the drag ended.
window.addEventListener('pet-dragend', () => {
  window.clawd?.play(restClip());
  nudge();
});

character.addEventListener('mouseenter', () => {
  const clip = window.clawd?.current();
  nudge();
  if (clip === 'idle' || clip === 'tired') window.clawd.play('hover', restClip());
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuEl.hidden) { e.preventDefault(); closeMenu(); return; }
  if (e.key !== 'Escape' || e.defaultPrevented || dialog.hidden) return;
  const a = document.activeElement;
  if (!dialog.contains(a) && a !== character && a !== document.body) return;
  e.preventDefault();
  dismiss();
});

// ── Right-click menu ────────────────────────────────────────────────────────
// A real menu, so it gets the full keyboard contract: focus moves in, arrows
// cycle, Escape closes and hands focus back to the character.
const menuItems = [...menuEl.querySelectorAll('.menu__item')];

function labelMenu() {
  for (const item of menuItems) {
    const text = {
      sit: sitting ? 'Stand up' : 'Sit',
      usage: dialog.hidden ? 'Show usage' : 'Hide usage',
      motion: window.clawd?.isPaused() ? 'Resume motion' : 'Pause motion',
    }[item.dataset.action];
    if (text) item.textContent = text;
  }
}

function openMenu() {
  nudge();
  labelMenu();
  menuEl.hidden = false;
  menuItems[0].focus();
}

function closeMenu({ refocus = true } = {}) {
  if (menuEl.hidden) return;
  const hadFocus = menuEl.contains(document.activeElement);
  menuEl.hidden = true;
  if (refocus && hadFocus) character.focus();
}

function runMenu(action) {
  if (action === 'sit') setSitting(!sitting);
  else if (action === 'usage') { if (dialog.hidden) refresh({ show: true }); else dismiss(); }
  else if (action === 'motion') motionBtn.click();
  closeMenu();
}

character.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (menuEl.hidden) openMenu(); else closeMenu();
});

menuEl.addEventListener('click', (e) => {
  const item = e.target.closest('.menu__item');
  if (item) runMenu(item.dataset.action);
});

menuEl.addEventListener('keydown', (e) => {
  const i = menuItems.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    menuItems[(i + step + menuItems.length) % menuItems.length].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    menuItems[e.key === 'Home' ? 0 : menuItems.length - 1].focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
  } else if (e.key === 'Tab') {
    closeMenu({ refocus: false });
  }
});

// Shift+F10 and the dedicated Menu key are the keyboard way to a context menu.
character.addEventListener('keydown', (e) => {
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    openMenu();
  }
});

document.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target) && !character.contains(e.target)) {
    closeMenu({ refocus: false });
  }
});

// ── Moving the pet ──────────────────────────────────────────────────────────
// Dragging must not be the only way to reposition an always-on-top window.
function moveBy(dx, dy) {
  if (globalThis.miniClaude?.moveBy) { globalThis.miniClaude.moveBy(dx, dy); return; }
  const r = pet.getBoundingClientRect();
  pet.style.left = `${r.left + dx}px`;
  pet.style.top = `${r.top + dy}px`;
}

character.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 32 : 8;
  const delta = {
    ArrowUp: [0, -step], ArrowDown: [0, step],
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
  }[e.key];
  if (!delta) return;
  e.preventDefault();
  nudge();
  moveBy(delta[0], delta[1]);
});

let dragging = false, justDragged = false, startX = 0, startY = 0, baseX = 0, baseY = 0;
character.addEventListener('pointerdown', (e) => {
  if (TAURI || e.button !== 0) return;   // native.js owns dragging in the shell
  dragging = true;
  justDragged = false;
  startX = e.clientX; startY = e.clientY;
  const r = pet.getBoundingClientRect();
  baseX = r.left; baseY = r.top;
  character.setPointerCapture(e.pointerId);
});
character.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - startX, dy = e.clientY - startY;
  if (!justDragged && Math.abs(dx) + Math.abs(dy) > 4) {
    justDragged = true;
    window.clawd?.play('drag');
  }
  pet.style.left = `${baseX + dx}px`;
  pet.style.top = `${baseY + dy}px`;
});
character.addEventListener('pointerup', () => {
  if (justDragged) window.clawd?.idle();
  dragging = false;
  setTimeout(() => { justDragged = false; }, 50);
});

// ── Boot ────────────────────────────────────────────────────────────────────
buildBars();
renderTokens();
wireTips();
try {
  if (localStorage.getItem('miniClaude.sit') === '1') {
    sitting = true;
    window.clawd?.play('sit');
    armCry();
  }
} catch { /* private mode */ }
armSleep();
initMotionToggle();
setActivity(false);
await loadConfig();
await refresh();
listenNative();
initAutostart();

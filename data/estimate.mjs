// Estimate Claude usage from local Claude Code logs (~/.claude/projects/**/*.jsonl).
// Outputs src/usage.json that the Mini Claude UI reads.
//
// Limits are not published by Anthropic, so percentages are an approximation
// driven by src/config.json (calibrate against /usage once).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PROJECTS = join(homedir(), '.claude', 'projects');
const OUT = fileURLToPath(new URL('../src/usage.json', import.meta.url));
const CONFIG = fileURLToPath(new URL('../src/config.json', import.meta.url));

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WINDOW_5H = 5 * HOUR;
const WINDOW_WEEK = 7 * DAY;

// Same resolution order as the Rust backend (src-tauri/src/lib.rs):
// src/config.json holds the shipped defaults, ~/.mini-claude/config.json
// shallow-merges over them so calibration needs no rebuild.
const OVERRIDE = join(homedir(), '.mini-claude', 'config.json');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function loadConfig() {
  const base = (await readJson(CONFIG)) ?? {};
  const over = (await readJson(OVERRIDE)) ?? {};
  return {
    ...base, ...over,
    limits:  { ...(base.limits  ?? {}), ...(over.limits  ?? {}) },
    weights: { ...(base.weights ?? {}), ...(over.weights ?? {}) },
  };
}

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function weighted(u, w) {
  return (u.input_tokens || 0) * w.input
    + (u.output_tokens || 0) * w.output
    + (u.cache_creation_input_tokens || 0) * w.cacheWrite
    + (u.cache_read_input_tokens || 0) * w.cacheRead;
}

async function collect(cutoff, weights) {
  const seen = new Set();           // dedup by message id
  const events = [];                // { ts, units, opus }
  for await (const file of walk(PROJECTS)) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj.message;
      if (obj.type !== 'assistant' || !msg?.usage) continue;
      const ts = Date.parse(obj.timestamp);
      if (!ts || ts < cutoff) continue;
      const id = msg.id || obj.uuid;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      events.push({
        ts,
        units: weighted(msg.usage, weights),
        opus: /opus/i.test(msg.model || ''),
      });
    }
  }
  return events;
}

function bucket(events, windowMs, filter = () => true) {
  const now = Date.now();
  const start = now - windowMs;
  const inWin = events.filter((e) => e.ts >= start && filter(e));
  const used = inWin.reduce((s, e) => s + e.units, 0);
  // rolling reset: oldest activity in window + window length
  const oldest = inWin.length ? Math.min(...inWin.map((e) => e.ts)) : now;
  const resetsAt = inWin.length ? oldest + windowMs : null;
  return { used: Math.round(used), resetsAt };
}

async function main() {
  const cfg = await loadConfig();
  const w = cfg.weights || { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
  const events = await collect(Date.now() - WINDOW_WEEK, w);

  const five = bucket(events, WINDOW_5H);
  const week = bucket(events, WINDOW_WEEK);
  const opus = bucket(events, WINDOW_WEEK, (e) => e.opus);

  const out = {
    source: 'estimate',
    updatedAt: Date.now(),
    limits: [
      { id: '5h',   used: five.used, limit: cfg.limits?.['5h']  ?? null, resetsAt: five.resetsAt },
      { id: 'week', used: week.used, limit: cfg.limits?.week    ?? null, resetsAt: week.resetsAt },
      { id: 'opus', used: opus.used, limit: cfg.limits?.opus    ?? null, resetsAt: opus.resetsAt },
      // 'design' has no local source yet -> omitted (UI shows N/A)
    ],
  };

  await writeFile(OUT, JSON.stringify(out, null, 2));
  const pct = (u, l) => (l ? Math.round((u / l) * 100) + '%' : 'N/A');
  console.log('Mini Claude usage estimate written to src/usage.json');
  console.log(`  5h:   ${out.limits[0].used.toLocaleString()} units (${pct(five.used, cfg.limits?.['5h'])})`);
  console.log(`  week: ${out.limits[1].used.toLocaleString()} units (${pct(week.used, cfg.limits?.week)})`);
  console.log(`  opus: ${out.limits[2].used.toLocaleString()} units (${pct(opus.used, cfg.limits?.opus)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });

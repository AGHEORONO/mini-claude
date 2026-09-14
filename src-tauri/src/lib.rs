use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
const WINDOW_5H: i64 = 5 * HOUR;
const WINDOW_WEEK: i64 = 7 * DAY;

// ── Config ──────────────────────────────────────────────────────────────────
// Defaults are compiled straight from src/config.json — the same file
// data/estimate.mjs reads — so there is exactly one source of truth.
// ~/.mini-claude/config.json shallow-merges over it (no rebuild needed).

const DEFAULT_CONFIG: &str = include_str!("../../src/config.json");

#[derive(Deserialize, Clone)]
struct Weights {
    input: f64,
    output: f64,
    #[serde(rename = "cacheWrite")]
    cache_write: f64,
    #[serde(rename = "cacheRead")]
    cache_read: f64,
}

#[derive(Deserialize, Default, Clone)]
struct Limits {
    #[serde(rename = "5h")]
    five: Option<i64>,
    week: Option<i64>,
    opus: Option<i64>,
}

#[derive(Deserialize, Clone)]
struct Config {
    #[serde(default)]
    limits: Limits,
    weights: Weights,
    #[serde(rename = "pollSeconds", default = "default_poll")]
    poll_seconds: u64,
    #[serde(rename = "dangerPct", default = "default_danger")]
    danger_pct: i64,
    #[serde(rename = "exhaustedPct", default = "default_exhausted")]
    exhausted_pct: i64,
}

fn default_poll() -> u64 { 300 }
fn default_danger() -> i64 { 90 }
fn default_exhausted() -> i64 { 99 }

/// Recursively overlay `over` onto `base` (objects merge, scalars replace).
fn merge_json(base: &mut Value, over: &Value) {
    let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) else { return };
    for (k, v) in o {
        match b.get_mut(k) {
            Some(bv) if bv.is_object() && v.is_object() => merge_json(bv, v),
            _ => { b.insert(k.clone(), v.clone()); }
        }
    }
}

/// Read once per process — the override file is user calibration, not hot state.
fn config() -> &'static Config {
    static CFG: OnceLock<Config> = OnceLock::new();
    CFG.get_or_init(|| {
        let mut v: Value =
            serde_json::from_str(DEFAULT_CONFIG).expect("src/config.json is not valid JSON");
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".mini-claude").join("config.json");
            if let Ok(txt) = fs::read_to_string(&p) {
                // Notepad, PowerShell's Out-File and VS Code all happily write
                // a UTF-8 BOM, and serde_json refuses to parse past it.
                let txt = txt.trim_start_matches('\u{feff}');
                match serde_json::from_str::<Value>(txt) {
                    Ok(over) => merge_json(&mut v, &over),
                    Err(e) => eprintln!("[mini-claude] ignoring bad {}: {e}", p.display()),
                }
            }
        }
        serde_json::from_value(v).expect("merged config does not match schema")
    })
}

// ── Wire types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Bar {
    id: String,
    used: i64,
    limit: Option<i64>,
    resets_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pct: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Usage {
    source: String,
    updated_at: i64,
    limits: Vec<Bar>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UiConfig {
    poll_seconds: u64,
    danger_pct: i64,
    exhausted_pct: i64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TokenSum {
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
    total: u64,
    messages: u64,
}

impl TokenSum {
    fn add(&mut self, e: &LogEvent) {
        self.input += e.input as u64;
        self.output += e.output as u64;
        self.cache_write += e.cache_write as u64;
        self.cache_read += e.cache_read as u64;
        self.total += e.input as u64 + e.output as u64 + e.cache_write as u64 + e.cache_read as u64;
        self.messages += 1;
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Totals {
    month_label: String,
    month: TokenSum,
    all_time: TokenSum,
    since_label: String,
}

#[derive(Serialize, Clone)]
struct WorkingPayload {
    active: bool,
}

// Raw token counts, not pre-weighted: the scan cache then stays valid
// regardless of the weights, and weighting is a cheap pass at bucket time.
#[derive(Clone)]
struct LogEvent {
    ts: i64,
    id: u64,
    input: u32,
    output: u32,
    cache_write: u32,
    cache_read: u32,
    opus: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_iso(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let mo: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    let time = rest.trim_end_matches('Z');
    let (time, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut tp = time.split(':');
    let h: i64 = tp.next()?.parse().ok()?;
    let mi: i64 = tp.next()?.parse().ok()?;
    let se: i64 = tp.next().unwrap_or("0").parse().ok()?;
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().unwrap_or(0);
    Some(days_from_civil(y, mo, d) * DAY + ((h * 60 + mi) * 60 + se) * 1000 + ms)
}

/// Inverse of days_from_civil, for bucketing history by calendar month.
fn civil_from_days(z: i64) -> (i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m)
}

/// UTC month key. Messages within a few hours of a month boundary can land in
/// the neighbouring month in local time; not worth a timezone database.
fn month_key(ts: i64) -> String {
    let (y, m) = civil_from_days(ts.div_euclid(DAY));
    format!("{y:04}-{m:02}")
}

fn hash_id(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// ── Incremental JSONL scanner ───────────────────────────────────────────────
// Claude Code only ever appends to these files, so after the first pass we seek
// to the byte offset we stopped at and parse the new tail only. The first call
// reads everything once; every call after that touches a few kilobytes.
//
// Nothing is pruned by age: the whole history is a few thousand records, and
// keeping it is what makes the month and all-time totals possible without a
// second scanner that could drift out of step with this one.

struct FileScan {
    offset: u64,
    events: Vec<LogEvent>,
}

static SCAN_CACHE: Mutex<Option<HashMap<PathBuf, FileScan>>> = Mutex::new(None);

fn collect_jsonl(dir: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            collect_jsonl(&p, out);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push((p, meta.len()));
        }
    }
}

fn parse_line(line: &str) -> Option<LogEvent> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let obj: Value = serde_json::from_str(line).ok()?;
    if obj.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let msg = obj.get("message")?;
    let usage = msg.get("usage")?;
    let ts = parse_iso(obj.get("timestamp")?.as_str()?)?;
    let id = msg
        .get("id")
        .and_then(|v| v.as_str())
        .or_else(|| obj.get("uuid").and_then(|v| v.as_str()))
        .unwrap_or("");
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    Some(LogEvent {
        ts,
        id: if id.is_empty() { 0 } else { hash_id(id) },
        input: g("input_tokens"),
        output: g("output_tokens"),
        cache_write: g("cache_creation_input_tokens"),
        cache_read: g("cache_read_input_tokens"),
        opus: msg
            .get("model")
            .and_then(|v| v.as_str())
            .is_some_and(|m| m.to_lowercase().contains("opus")),
    })
}

/// Parse the bytes appended since the last visit to this file.
fn read_tail(path: &Path, entry: &mut FileScan) {
    let Ok(mut f) = File::open(path) else { return };
    if f.seek(SeekFrom::Start(entry.offset)).is_err() {
        return;
    }
    let mut reader = BufReader::new(&mut f);
    let mut line = String::new();
    let mut read = entry.offset;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => {
                // A partial trailing line means the writer is mid-append, so
                // the offset stays before it and the whole line is re-read.
                if !line.ends_with('\n') {
                    break;
                }
                read += n as u64;
                if let Some(ev) = parse_line(&line) {
                    entry.events.push(ev);
                }
            }
            Err(_) => break,
        }
    }
    entry.offset = read;
}

/// Every assistant message ever logged, deduplicated.
///
/// Deduplication is not optional: resuming a session copies its whole history
/// into the new file, and on a real install that is over half of all the lines.
fn all_events() -> Vec<LogEvent> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let projects = home.join(".claude").join("projects");

    let mut files = Vec::new();
    collect_jsonl(&projects, &mut files);

    let Ok(mut guard) = SCAN_CACHE.lock() else { return Vec::new() };
    let cache = guard.get_or_insert_with(HashMap::new);
    let live: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
    cache.retain(|p, _| live.contains(p));

    let mut out = Vec::new();
    for (path, len) in &files {
        let entry = cache.entry(path.clone()).or_insert(FileScan {
            offset: 0,
            events: Vec::new(),
        });
        // Truncated or rotated, so the cached tail is meaningless.
        if *len < entry.offset {
            entry.offset = 0;
            entry.events.clear();
        }
        if *len > entry.offset {
            read_tail(path, entry);
        }
        out.extend(entry.events.iter().cloned());
    }

    let mut seen = HashSet::with_capacity(out.len());
    out.retain(|e| e.id == 0 || seen.insert(e.id));
    out
}

fn collect_events(cutoff: i64) -> Vec<LogEvent> {
    let mut events = all_events();
    events.retain(|e| e.ts >= cutoff);
    events
}

fn bucket(events: &[LogEvent], window: i64, opus_only: bool) -> (i64, Option<i64>) {
    let w = &config().weights;
    let start = now_ms() - window;
    let mut used = 0.0;
    let mut oldest = i64::MAX;
    for e in events {
        if e.ts < start || (opus_only && !e.opus) {
            continue;
        }
        used += e.input as f64 * w.input
            + e.output as f64 * w.output
            + e.cache_write as f64 * w.cache_write
            + e.cache_read as f64 * w.cache_read;
        oldest = oldest.min(e.ts);
    }
    let resets_at = if oldest == i64::MAX { None } else { Some(oldest + window) };
    (used.round() as i64, resets_at)
}

fn compute_estimate() -> Usage {
    let cfg = config();
    let events = collect_events(now_ms() - WINDOW_WEEK);
    let (u5, r5) = bucket(&events, WINDOW_5H, false);
    let (uw, rw) = bucket(&events, WINDOW_WEEK, false);
    let (uo, ro) = bucket(&events, WINDOW_WEEK, true);
    Usage {
        source: "estimate".into(),
        updated_at: now_ms(),
        limits: vec![
            Bar { id: "5h".into(), used: u5, limit: cfg.limits.five, resets_at: r5, pct: None },
            Bar { id: "week".into(), used: uw, limit: cfg.limits.week, resets_at: rw, pct: None },
            Bar { id: "opus".into(), used: uo, limit: cfg.limits.opus, resets_at: ro, pct: None },
        ],
    }
}

// ── Real API ────────────────────────────────────────────────────────────────

fn read_access_token() -> Option<String> {
    let home = dirs::home_dir()?;
    let text = fs::read_to_string(home.join(".claude").join(".credentials.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let token = v["claudeAiOauth"]["accessToken"].as_str()?;
    if token.is_empty() { None } else { Some(token.to_string()) }
}

struct RealCache {
    fetched_at: i64,
    usage: Option<Usage>,
}

static REAL_CACHE: Mutex<Option<RealCache>> = Mutex::new(None);

// Every real reading costs a billed inference request, so it is rate limited.
const CACHE_TTL_MS: i64 = 5 * 60 * 1000;
// Floor enforced even when the watcher invalidates the cache mid-window.
const MIN_REFETCH_MS: i64 = 45 * 1000;
// How long a failure is remembered before the network is tried again.
const FAIL_TTL_MS: i64 = 60 * 1000;

/// Drop the cached reading, but never sooner than MIN_REFETCH_MS after it.
fn soft_invalidate() {
    if let Ok(mut g) = REAL_CACHE.lock() {
        let stale = g
            .as_ref()
            .is_some_and(|c| now_ms() - c.fetched_at >= MIN_REFETCH_MS);
        if stale {
            *g = None;
        }
    }
}

/// `Some(hit)` when the cache still answers, `None` when a fetch is due.
fn cached_real() -> Option<Option<Usage>> {
    let g = REAL_CACHE.lock().ok()?;
    let c = g.as_ref()?;
    let ttl = if c.usage.is_some() { CACHE_TTL_MS } else { FAIL_TTL_MS };
    if now_ms() - c.fetched_at < ttl {
        Some(c.usage.clone())
    } else {
        None
    }
}

async fn fetch_real_usage() -> Option<Usage> {
    if let Some(hit) = cached_real() {
        return hit;
    }
    let result = fetch_real_uncached().await;
    if let Ok(mut g) = REAL_CACHE.lock() {
        *g = Some(RealCache { fetched_at: now_ms(), usage: result.clone() });
    }
    result
}

async fn fetch_real_uncached() -> Option<Usage> {
    let token = read_access_token()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;

    // The smallest billable request there is; only the headers are wanted.
    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "0"}]
    });

    let resp = match client
        .post("https://api.anthropic.com/v1/messages")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[mini-claude] API send error: {e}");
            return None;
        }
    };

    let status = resp.status();
    let headers = resp.headers();
    let num = |key: &str| -> Option<f64> { headers.get(key)?.to_str().ok()?.trim().parse().ok() };

    let (Some(util_5h), Some(reset_5h), Some(util_7d), Some(reset_7d)) = (
        num("anthropic-ratelimit-unified-5h-utilization"),
        num("anthropic-ratelimit-unified-5h-reset"),
        num("anthropic-ratelimit-unified-7d-utilization"),
        num("anthropic-ratelimit-unified-7d-reset"),
    ) else {
        eprintln!("[mini-claude] rate-limit headers missing (status {status}) — using estimate");
        return None;
    };

    let pct = |u: f64| (u * 100.0).round() as i64;

    // The unified headers carry no per-model breakdown, and the guessed limit
    // in config.json was wildly off (it pegged this bar at 100% while the real
    // weekly figure sat at a quarter). So instead of guessing a limit, work out
    // what share of the local weighted usage was Opus and apply that share to
    // the weekly percentage Anthropic actually reported. On a plan where every
    // model draws on the same weekly budget that is a real number: "Opus has
    // eaten this much of your week".
    let events = collect_events(now_ms() - WINDOW_WEEK);
    let (uo, ro) = bucket(&events, WINDOW_WEEK, true);
    let (uw, _) = bucket(&events, WINDOW_WEEK, false);
    let opus_pct = if uw > 0 {
        ((uo as f64 / uw as f64) * util_7d * 100.0).round() as i64
    } else {
        0
    };

    Some(Usage {
        source: "real".into(),
        updated_at: now_ms(),
        limits: vec![
            Bar {
                id: "5h".into(),
                used: pct(util_5h),
                limit: Some(100),
                resets_at: Some(reset_5h as i64 * 1000),
                pct: Some(pct(util_5h)),
            },
            Bar {
                id: "week".into(),
                used: pct(util_7d),
                limit: Some(100),
                resets_at: Some(reset_7d as i64 * 1000),
                pct: Some(pct(util_7d)),
            },
            Bar {
                id: "opus".into(),
                used: opus_pct,
                limit: Some(100),
                resets_at: ro,
                pct: Some(opus_pct),
            },
        ],
    })
}

#[tauri::command]
async fn get_usage() -> Usage {
    match fetch_real_usage().await {
        Some(real) => real,
        None => compute_estimate(),
    }
}

/// Raw token counts for the current calendar month and for all of history.
/// Unweighted on purpose: this row answers "how much have I put through it",
/// not "how close am I to a limit".
#[tauri::command]
fn get_totals() -> Totals {
    let events = all_events();
    let this_month = month_key(now_ms());
    let mut t = Totals {
        month_label: this_month.clone(),
        since_label: events.first().map(|e| month_key(e.ts)).unwrap_or_default(),
        ..Default::default()
    };
    for e in &events {
        t.all_time.add(e);
        if month_key(e.ts) == this_month {
            t.month.add(e);
        }
    }
    t
}

#[tauri::command]
fn get_config() -> UiConfig {
    let c = config();
    UiConfig {
        poll_seconds: c.poll_seconds,
        danger_pct: c.danger_pct,
        exhausted_pct: c.exhausted_pct,
    }
}

// ── Auto-start ──────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn autostart_key() -> Option<winreg::RegKey> {
    use winreg::enums::*;
    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_READ | KEY_WRITE,
        )
        .ok()
}

#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        autostart_key().is_some_and(|k| k.get_value::<String, _>("MiniClaude").is_ok())
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let key = autostart_key().ok_or("cannot open the Windows Run registry key")?;
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value("MiniClaude", &exe.to_string_lossy().to_string())
                .map_err(|e| e.to_string())?;
        } else {
            let _ = key.delete_value("MiniClaude");
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Ok(())
    }
}

// ── File watcher ────────────────────────────────────────────────────────────
// Drives both the "Claude is working" animation and the bar refreshes. The
// events carry no payload: the UI calls get_usage() itself, so an estimate
// computed here would only be thrown away.

fn start_watcher(app: tauri::AppHandle) {
    use notify::{EventKind, RecursiveMode, Watcher};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let Some(home) = dirs::home_dir() else { return };
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return;
    }

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let Ok(mut watcher) = notify::RecommendedWatcher::new(tx, notify::Config::default()) else {
            return;
        };
        if watcher.watch(&projects_dir, RecursiveMode::Recursive).is_err() {
            return;
        }

        let long_ago = Instant::now() - Duration::from_secs(3600);
        let mut last_write = long_ago;
        let mut last_ping = long_ago;
        let mut working = false;
        let idle_after = Duration::from_secs(3);
        let heartbeat = Duration::from_secs(60);

        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(event)) => {
                    let touched_jsonl = matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_)
                    ) && event
                        .paths
                        .iter()
                        .any(|p| p.extension().is_some_and(|x| x == "jsonl"));
                    if !touched_jsonl {
                        continue;
                    }
                    last_write = Instant::now();
                    if !working {
                        working = true;
                        let _ = app.emit("claude-working", WorkingPayload { active: true });
                    }
                }
                Ok(Err(_)) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // The burst just ended, so Claude Code produced a full
                    // response: this is the moment a fresh reading is worth it.
                    if working && last_write.elapsed() >= idle_after {
                        working = false;
                        last_ping = Instant::now();
                        let _ = app.emit("claude-working", WorkingPayload { active: false });
                        soft_invalidate();
                        let _ = app.emit("usage-updated", ());
                    }
                    if last_ping.elapsed() >= heartbeat {
                        last_ping = Instant::now();
                        let _ = app.emit("usage-updated", ());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

// ── Entry point ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_usage,
            get_config,
            get_totals,
            get_autostart,
            set_autostart,
        ])
        .setup(|app| {
            start_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Mini Claude");
}

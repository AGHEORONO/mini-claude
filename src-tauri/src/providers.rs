// Every AI CLI the pet knows how to read, behind one `usage` / `totals` pair.
//
// Each provider reports whatever it can honestly measure:
// - Claude Code: real rate-limit headers (see lib.rs), local token log.
// - Codex: the rate-limit snapshot Codex itself writes into its session logs,
//   so the bars cost nothing to read and match `/status` as of the last turn.
// - Gemini CLI / Qwen Code: free tiers that cap requests per day; the count
//   comes from the local chat logs and the cap from config.json.
// - opencode: bills your own provider keys, so there is no plan limit to show,
//   only the token log in its SQLite database.
// - GitHub Copilot: monthly quotas from GitHub's own endpoint, using the token
//   the GitHub CLI already holds. No local token log exists.

use super::*;

#[derive(Serialize)]
pub struct Found {
    id: &'static str,
    found: bool,
}

pub const IDS: [&str; 6] = ["claude", "codex", "gemini", "qwen", "opencode", "copilot"];

fn data_dir(id: &str) -> Option<PathBuf> {
    match id {
        "claude" => home_path(&[".claude", "projects"]),
        "codex" => home_path(&[".codex", "sessions"]),
        "gemini" => home_path(&[".gemini", "tmp"]),
        "qwen" => home_path(&[".qwen", "tmp"]),
        "opencode" => home_path(&[".local", "share", "opencode"]),
        "copilot" => home_path(&[".copilot"]),
        _ => None,
    }
}

/// Which providers have ever run on this machine. Copilot counts as found
/// when either its CLI folder or the GitHub CLI is there, since the quota is
/// read through the latter.
pub fn list() -> Vec<Found> {
    IDS.iter()
        .map(|&id| Found {
            id,
            found: data_dir(id).is_some_and(|d| d.exists()) || (id == "copilot" && gh_path().is_some()),
        })
        .collect()
}

pub struct WatchRoot {
    pub provider: &'static str,
    pub dir: PathBuf,
    pub recursive: bool,
    pub matches: fn(&Path) -> bool,
}

fn ext_is(p: &Path, ext: &str) -> bool {
    p.extension().is_some_and(|x| x == ext)
}

pub fn watch_roots() -> Vec<WatchRoot> {
    let mut out = Vec::new();
    let mut add = |provider: &'static str, dir: Option<PathBuf>, recursive: bool, matches: fn(&Path) -> bool| {
        if let Some(dir) = dir {
            out.push(WatchRoot { provider, dir, recursive, matches });
        }
    };
    add("claude", data_dir("claude"), true, |p| ext_is(p, "jsonl"));
    add("codex", data_dir("codex"), true, |p| ext_is(p, "jsonl"));
    add("gemini", data_dir("gemini"), true, |p| ext_is(p, "json") && in_chats(p));
    add("qwen", data_dir("qwen"), true, |p| ext_is(p, "json") && in_chats(p));
    // Only the database itself: the folder also holds logs and snapshots.
    add("opencode", data_dir("opencode"), false, |p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("opencode.db"))
    });
    add("copilot", home_path(&[".copilot", "session-state"]), true, |p| ext_is(p, "jsonl"));
    out
}

fn in_chats(p: &Path) -> bool {
    p.parent().and_then(|d| d.file_name()).is_some_and(|n| n == "chats")
}

pub async fn usage(id: &str) -> Usage {
    match id {
        "claude" => claude_usage().await,
        "codex" => codex_usage(),
        "gemini" | "qwen" => daily_usage(id),
        "copilot" => copilot_usage().await,
        _ => empty(id, "none"),
    }
}

pub fn totals(id: &str) -> Option<Totals> {
    let events = match id {
        "claude" => all_events(),
        "codex" => codex_scan().0,
        "gemini" | "qwen" => chat_events(id),
        "opencode" => opencode_events(),
        _ => return None,
    };
    Some(totals_of(&events))
}

fn empty(id: &str, source: &str) -> Usage {
    Usage { provider: id.into(), source: source.into(), updated_at: now_ms(), limits: Vec::new() }
}

// ── Codex ───────────────────────────────────────────────────────────────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Every turn appends a
// `token_count` event carrying both the turn's token usage and the account's
// current rate-limit snapshot.

fn codex_line(line: &str, f: &mut FileScan) {
    if !line.contains("\"token_count\"") {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let p = &v["payload"];
    if p["type"] != "token_count" {
        return;
    }
    let ts = v["timestamp"].as_str().and_then(parse_iso).unwrap_or(0);
    if p["rate_limits"].is_object() && f.latest.as_ref().map_or(true, |(t, _)| ts >= *t) {
        f.latest = Some((ts, p["rate_limits"].clone()));
    }
    let info = &p["info"];
    let last = &info["last_token_usage"];
    if !last.is_object() {
        return;
    }
    let g = |k: &str| last[k].as_u64().unwrap_or(0);
    // The same snapshot is often written twice in a row, and resuming copies
    // the history into a new file. The running total plus the increment is
    // unique per real turn, so it doubles as the dedup id.
    let id = hash_id(&format!("{}|{}", info["total_token_usage"], last));
    let cached = g("cached_input_tokens");
    f.events.push(LogEvent {
        ts,
        id,
        // OpenAI counts cached tokens inside input_tokens.
        input: g("input_tokens").saturating_sub(cached) as u32,
        output: g("output_tokens") as u32,
        cache_write: g("cache_write_input_tokens") as u32,
        cache_read: cached as u32,
        opus: false,
    });
}

fn codex_scan() -> (Vec<LogEvent>, Option<(i64, Value)>) {
    match data_dir("codex") {
        Some(root) => scan_jsonl(&root, codex_line),
        None => (Vec::new(), None),
    }
}

fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5h Session".into(),
        10080 => "Weekly".into(),
        m if (43000..=44700).contains(&m) => "Monthly".into(),
        m if m % 1440 == 0 => format!("{}-day window", m / 1440),
        m if m % 60 == 0 => format!("{}h window", m / 60),
        m => format!("{m}m window"),
    }
}

fn codex_usage() -> Usage {
    let (_, latest) = codex_scan();
    let Some((ts, rl)) = latest else { return empty("codex", "none") };
    let now = now_ms();
    let mut limits = Vec::new();
    for slot in ["primary", "secondary"] {
        let w = &rl[slot];
        let Some(used) = w["used_percent"].as_f64() else { continue };
        let minutes = w["window_minutes"].as_i64().unwrap_or(0);
        // Newer builds write an absolute reset, older ones a countdown from
        // the moment the snapshot was taken.
        let resets_at = w["resets_at"]
            .as_i64()
            .map(|s| s * 1000)
            .or_else(|| w["resets_in_seconds"].as_i64().map(|s| ts + s * 1000));
        // The snapshot is only as fresh as the last Codex turn. Once its window
        // has rolled over, the honest reading is an empty bar.
        let pct = if resets_at.is_some_and(|r| r <= now) { 0 } else { used.round() as i64 };
        limits.push(Bar {
            id: slot.into(),
            label: window_label(minutes),
            used: pct,
            limit: Some(100),
            resets_at: resets_at.filter(|r| *r > now),
            pct: Some(pct),
        });
    }
    Usage { provider: "codex".into(), source: "logs".into(), updated_at: ts, limits }
}

// ── Gemini CLI / Qwen Code ──────────────────────────────────────────────────
// ~/.gemini/tmp/<project>/chats/session-*.json, rewritten whole on every turn,
// so files are re-read when their size or mtime changes rather than tailed.
// Qwen Code is a fork and keeps the same layout under ~/.qwen.

struct ChatFile {
    len: u64,
    mtime: Option<SystemTime>,
    events: Vec<LogEvent>,
}

static CHAT_CACHE: Mutex<Option<HashMap<PathBuf, ChatFile>>> = Mutex::new(None);

fn chat_message(m: &Value) -> Option<LogEvent> {
    let t = m.get("tokens")?;
    let ts = parse_iso(m.get("timestamp")?.as_str()?)?;
    let g = |k: &str| t.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let cached = g("cached");
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    Some(LogEvent {
        ts,
        id: if id.is_empty() { 0 } else { hash_id(id) },
        // Gemini's prompt count includes the cached part, like OpenAI's.
        input: g("input").saturating_sub(cached) as u32,
        // Thinking tokens are billed as output.
        output: (g("output") + g("thoughts")) as u32,
        cache_write: 0,
        cache_read: cached as u32,
        opus: false,
    })
}

fn chat_events(id: &str) -> Vec<LogEvent> {
    let Some(root) = data_dir(id) else { return Vec::new() };
    let mut files = Vec::new();
    collect_files(&root, "json", &mut files);
    files.retain(|(p, _)| in_chats(p));

    let Ok(mut guard) = CHAT_CACHE.lock() else { return Vec::new() };
    let cache = guard.get_or_insert_with(HashMap::new);
    let live: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
    cache.retain(|p, _| !p.starts_with(&root) || live.contains(p));

    let mut out = Vec::new();
    for (path, len) in &files {
        let mtime = fs::metadata(path).and_then(|m| m.modified()).ok();
        let fresh = cache.get(path).is_some_and(|c| c.len == *len && c.mtime == mtime);
        if !fresh {
            let events = fs::read_to_string(path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .map(|v| {
                    let msgs = v.get("messages").cloned().unwrap_or(v);
                    msgs.as_array()
                        .map(|a| a.iter().filter_map(chat_message).collect())
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            cache.insert(path.clone(), ChatFile { len: *len, mtime, events });
        }
        out.extend(cache[path].events.iter().cloned());
    }
    let mut seen = HashSet::with_capacity(out.len());
    out.retain(|e| e.id == 0 || seen.insert(e.id));
    out.sort_by_key(|e| e.ts);
    out
}

/// Start of the current day in US Pacific time, which is when Google's free
/// quotas roll over. DST is approximated by month; the edges are a day or two
/// off twice a year, which is fine for an estimate.
fn pacific_day_start(now: i64) -> i64 {
    let (_, month) = civil_from_days((now - 8 * HOUR).div_euclid(DAY));
    let offset = if (4..=10).contains(&month) { 7 * HOUR } else { 8 * HOUR };
    (now - offset).div_euclid(DAY) * DAY + offset
}

fn daily_usage(id: &str) -> Usage {
    let events = chat_events(id);
    let limit = config().daily_requests.get(id).copied().filter(|l| *l > 0);
    let now = now_ms();
    let start = pacific_day_start(now);
    let used = events.iter().filter(|e| e.ts >= start).count() as i64;
    let mut u = empty(id, "estimate");
    u.limits.push(Bar {
        id: "day".into(),
        label: "Requests today".into(),
        used,
        limit,
        resets_at: Some(start + DAY),
        pct: None,
    });
    u
}

// ── opencode ────────────────────────────────────────────────────────────────
// ~/.local/share/opencode/opencode.db, one JSON blob per message. Opened
// read-only on every call; the history is small and SQLite does the filtering.

fn opencode_events() -> Vec<LogEvent> {
    use rusqlite::{Connection, OpenFlags};
    let Some(db) = data_dir("opencode").map(|d| d.join("opencode.db")) else { return Vec::new() };
    let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return Vec::new();
    };
    let sql = "SELECT id,
                      json_extract(data, '$.time.created'),
                      json_extract(data, '$.tokens.input'),
                      json_extract(data, '$.tokens.output'),
                      json_extract(data, '$.tokens.reasoning'),
                      json_extract(data, '$.tokens.cache.write'),
                      json_extract(data, '$.tokens.cache.read')
               FROM message
               WHERE json_extract(data, '$.role') = 'assistant'";
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    let n = |r: &rusqlite::Row, i: usize| r.get::<_, Option<i64>>(i).ok().flatten().unwrap_or(0).max(0);
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        Ok(LogEvent {
            ts: n(r, 1),
            id: hash_id(&id),
            input: n(r, 2) as u32,
            output: (n(r, 3) + n(r, 4)) as u32,
            cache_write: n(r, 5) as u32,
            cache_read: n(r, 6) as u32,
            opus: false,
        })
    });
    let mut out: Vec<LogEvent> = match rows {
        Ok(rows) => rows.flatten().filter(|e| e.ts > 0).collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by_key(|e| e.ts);
    out
}

// ── GitHub Copilot ──────────────────────────────────────────────────────────
// GET api.github.com/copilot_internal/user returns the monthly quota
// snapshots the Copilot CLI shows in /usage. The token comes from GH_TOKEN /
// GITHUB_TOKEN, else from `gh auth token`, asked once per process.

struct CopilotCache {
    fetched_at: i64,
    usage: Usage,
}

static COPILOT_CACHE: Mutex<Option<CopilotCache>> = Mutex::new(None);
static GH_TOKEN: OnceLock<Option<String>> = OnceLock::new();

fn gh_path() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "gh.exe" } else { "gh" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file())
    })
}

fn gh_token() -> Option<String> {
    GH_TOKEN
        .get_or_init(|| {
            for var in ["GH_TOKEN", "GITHUB_TOKEN"] {
                if let Ok(t) = std::env::var(var) {
                    if !t.trim().is_empty() {
                        return Some(t.trim().to_string());
                    }
                }
            }
            let mut cmd = std::process::Command::new(gh_path()?);
            cmd.args(["auth", "token"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // Without this every lookup flashes a console window.
                cmd.creation_flags(0x0800_0000);
            }
            let out = cmd.output().ok()?;
            let t = String::from_utf8(out.stdout).ok()?.trim().to_string();
            if out.status.success() && !t.is_empty() { Some(t) } else { None }
        })
        .clone()
}

async fn copilot_usage() -> Usage {
    if let Ok(g) = COPILOT_CACHE.lock() {
        if let Some(c) = g.as_ref().filter(|c| now_ms() - c.fetched_at < CACHE_TTL_MS) {
            return c.usage.clone();
        }
    }
    let usage = copilot_fetch().await.unwrap_or_else(|| empty("copilot", "none"));
    // Failures are remembered for a minute only, so a login is picked up soon.
    let fetched_at = if usage.limits.is_empty() { now_ms() - CACHE_TTL_MS + FAIL_TTL_MS } else { now_ms() };
    if let Ok(mut g) = COPILOT_CACHE.lock() {
        *g = Some(CopilotCache { fetched_at, usage: usage.clone() });
    }
    usage
}

async fn copilot_fetch() -> Option<Usage> {
    let token = tokio::task::spawn_blocking(gh_token).await.ok()??;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;
    let v: Value = client
        .get("https://api.github.com/copilot_internal/user")
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", "mini-claude")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let resets_at = v["quota_reset_date_utc"].as_str().and_then(parse_iso);
    let mut u = empty("copilot", "real");
    for (key, label) in [
        ("premium_interactions", "Premium requests"),
        ("chat", "Chat"),
        ("completions", "Completions"),
    ] {
        let q = &v["quota_snapshots"][key];
        // Unlimited or not part of the plan: a bar would only ever read 0%.
        if q["unlimited"].as_bool() == Some(true) || q["entitlement"].as_f64().unwrap_or(0.0) <= 0.0 {
            continue;
        }
        let Some(left) = q["percent_remaining"].as_f64() else { continue };
        let pct = (100.0 - left).clamp(0.0, 100.0).round() as i64;
        u.limits.push(Bar { id: key.into(), label: label.into(), used: pct, limit: Some(100), resets_at, pct: Some(pct) });
    }
    Some(u)
}

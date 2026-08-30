use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;

/// ps から読み取った 1 プロセス。
#[derive(Debug, Clone)]
pub(crate) struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub uptime_secs: i64,
    pub rss_kb: u64,
    pub cmd: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct StaleProc {
    pub pid: i32,
    pub ppid: i32,
    /// 分類ラベル。UI のグルーピングに使う。
    pub category: String,
    /// なぜ候補に挙がったかの説明。
    pub reason: String,
    /// 確実な残骸なら true。UI が既定で選択する。
    pub certain: bool,
    pub name: String,
    pub cmd: String,
    pub uptime_secs: i64,
    pub rss_mb: u64,
}

#[derive(Debug, Serialize)]
pub struct DetectResult {
    pub procs: Vec<StaleProc>,
    /// 稼働中セッションとして除外したプロセス数。
    pub protected_count: usize,
    pub daemon_alive: bool,
    pub current_version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct KillResult {
    pub stopped: Vec<i32>,
    pub failed: Vec<KillFailure>,
}

#[derive(Debug, Serialize)]
pub struct KillFailure {
    pub pid: i32,
    pub reason: String,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `[[dd-]hh:]mm:ss` を秒に直す。
fn parse_etime(s: &str) -> i64 {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().unwrap_or(0), r),
        None => (0, s),
    };
    let mut parts: Vec<i64> = rest.split(':').map(|x| x.parse().unwrap_or(0)).collect();
    while parts.len() < 3 {
        parts.insert(0, 0);
    }
    days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
}

/// プロセス一覧を読む。
///
/// `pgrep -f` は daemon の起動引数に含まれる JSON のような長い行を取りこぼし、
/// daemon 本体を検出できない。ps の出力を自前で解析する。
pub(crate) fn read_procs() -> Result<HashMap<i32, Proc>, String> {
    let out = Command::new("ps")
        .args(["-eo", "pid=,ppid=,etime=,rss=,command="])
        .output()
        .map_err(|e| format!("ps を実行できませんでした: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut procs = HashMap::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(etime), Some(rss)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid), Ok(rss)) = (
            pid.parse::<i32>(),
            ppid.parse::<i32>(),
            rss.parse::<u64>(),
        ) else {
            continue;
        };
        // 4 つのフィールドを取り除いた残りがコマンドライン。
        let cmd = line
            .split_whitespace()
            .skip(4)
            .collect::<Vec<_>>()
            .join(" ");
        procs.insert(
            pid,
            Proc {
                pid,
                ppid,
                uptime_secs: parse_etime(etime),
                rss_kb: rss,
                cmd,
            },
        );
    }
    Ok(procs)
}

pub(crate) fn build_children(procs: &HashMap<i32, Proc>) -> HashMap<i32, Vec<i32>> {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in procs.values() {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    children
}

pub(crate) fn descendants(root: i32, children: &HashMap<i32, Vec<i32>>) -> HashSet<i32> {
    let mut seen = HashSet::new();
    let mut stack = vec![root];
    while let Some(cur) = stack.pop() {
        if let Some(kids) = children.get(&cur) {
            for &k in kids {
                if seen.insert(k) {
                    stack.push(k);
                }
            }
        }
    }
    seen
}

fn is_alive(pid: i32) -> bool {
    // シグナル 0 は送らずに到達可能かだけを確かめる。
    unsafe { libc::kill(pid, 0) == 0 }
}

/// 稼働中の Claude Code セッションを保護対象として集める。
///
/// roster に載っている worker とその子孫を除外しないと、作業中のセッションが
/// 抱える MCP や言語サーバーを停止候補として並べてしまう。
fn protected_set(procs: &HashMap<i32, Proc>, children: &HashMap<i32, Vec<i32>>) -> (HashSet<i32>, bool) {
    let mut protected = HashSet::new();
    let roster_path = home().join(".claude").join("daemon").join("roster.json");
    let Ok(text) = std::fs::read_to_string(roster_path) else {
        return (protected, false);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (protected, false);
    };

    let supervisor = v.get("supervisorPid").and_then(|x| x.as_i64()).map(|x| x as i32);
    let daemon_alive = supervisor.map(|p| procs.contains_key(&p)).unwrap_or(false);
    if let (Some(sup), true) = (supervisor, daemon_alive) {
        protected.insert(sup);
        protected.extend(descendants(sup, children));
    }

    if let Some(workers) = v.get("workers").and_then(|w| w.as_object()) {
        for w in workers.values() {
            if let Some(pid) = w.get("pid").and_then(|x| x.as_i64()).map(|x| x as i32) {
                if procs.contains_key(&pid) {
                    protected.insert(pid);
                    protected.extend(descendants(pid, children));
                }
            }
        }
    }
    (protected, daemon_alive)
}

fn current_version() -> Option<String> {
    let out = Command::new("/opt/homebrew/bin/claude")
        .arg("--version")
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .map(|s| s.to_string())
}

/// コマンドラインが参照する作業ディレクトリのうち、既に存在しないもの。
fn missing_path(cmd: &str, workspace: &str, worktree_re: &Regex) -> Option<String> {
    for token in cmd.split_whitespace() {
        let cleaned = token.trim_end_matches([',', ';', '"', '\'']);
        if !cleaned.starts_with(workspace) {
            continue;
        }
        if PathBuf::from(cleaned).exists() {
            continue;
        }
        // ファイルまで含む長いパスは worktree のルートまで削って判定し直す。
        if let Some(c) = worktree_re.captures(cleaned) {
            let root = c.get(1).map(|m| m.as_str()).unwrap_or(cleaned);
            if PathBuf::from(root).exists() {
                continue;
            }
            return Some(root.to_string());
        }
        return Some(cleaned.to_string());
    }
    None
}

/// 実行ファイル名だけでは `npm` や `node` ばかりになるため、
/// 実際に動かしているものの名前まで辿る。
pub(crate) fn short_name(cmd: &str) -> String {
    let base_of = |s: &str| {
        s.rsplit('/')
            .next()
            .unwrap_or(s)
            .trim_end_matches(".js")
            .to_string()
    };

    // `npm exec <パッケージ>` はパッケージ名が中身を表す。
    if let Some(rest) = cmd.split(" exec ").nth(1) {
        if let Some(pkg) = rest.split_whitespace().find(|a| !a.starts_with('-')) {
            let name = base_of(pkg);
            if !name.is_empty() {
                return name.trim_start_matches('@').to_string();
            }
        }
    }

    let mut parts = cmd.split_whitespace();
    let first = parts.next().unwrap_or("");
    let base = base_of(first);

    // 実行系はそれ自身より、渡されたスクリプト名の方が中身を表す。
    let is_runner = base.starts_with("node")
        || base == "npm"
        || base == "npx"
        || base.starts_with("python")
        || base == "uv"
        || base == "bash"
        || base == "sh"
        || base == "zsh";

    if is_runner {
        for arg in parts {
            if arg.starts_with('-') {
                continue;
            }
            let name = base_of(arg);
            if !name.is_empty() && name != base {
                return name;
            }
        }
    }

    if base.is_empty() {
        cmd.chars().take(40).collect()
    } else {
        base
    }
}

/// 残留プロセスを検出する。停止はしない。
pub fn detect(hours: f64) -> Result<DetectResult, String> {
    let procs = read_procs()?;
    let children = build_children(&procs);
    let (protected, daemon_alive) = protected_set(&procs, &children);
    let version = current_version();

    let mcp = Regex::new(r"chrome-devtools-mcp|notion-mcp-server|\.serena/language_servers")
        .map_err(|e| e.to_string())?;
    let cc = Regex::new(r"claude (bg-spare|bg-pty-host|daemon run|agents)|Caskroom/claude-code/[\d.]+/claude")
        .map_err(|e| e.to_string())?;
    let cask = Regex::new(r"Caskroom/claude-code/([\d.]+)/claude").map_err(|e| e.to_string())?;
    let worker = Regex::new(r"claude (bg-spare|bg-pty-host)").map_err(|e| e.to_string())?;
    let worktree_re = Regex::new(r"^(.*/(?:worktrees|\.worktrees)/[^/]+)").map_err(|e| e.to_string())?;

    // 常駐が正常なものを巻き込まないための除外。
    let dev_exclude = Regex::new(r"Application Support/Zed|Visual Studio Code|/Applications/")
        .map_err(|e| e.to_string())?;

    // 先に一致したラベルを採用する。vite は \b により vitest と区別できる。
    let dev_rules: Vec<(&str, Regex)> = vec![
        ("eslint", Regex::new(r"eslintServer|/eslint\b").map_err(|e| e.to_string())?),
        ("vitest/jest", Regex::new(r"vitest|jest").map_err(|e| e.to_string())?),
        ("vite", Regex::new(r"\bvite\b").map_err(|e| e.to_string())?),
        ("tsc/webpack", Regex::new(r"tsc --build|tsc -p|webpack").map_err(|e| e.to_string())?),
        ("LSP", Regex::new(r"typescript-language-server|tsserver\.js|langserver|pyright").map_err(|e| e.to_string())?),
        ("pytest/uv", Regex::new(r"pytest|uv run").map_err(|e| e.to_string())?),
        ("playwright", Regex::new(r"playwright").map_err(|e| e.to_string())?),
    ];

    let workspace = home().join("demia_works").to_string_lossy().to_string();
    let threshold = (hours * 3600.0) as i64;
    let mut out: Vec<StaleProc> = Vec::new();

    let push = |p: &Proc, category: &str, reason: String, certain: bool, out: &mut Vec<StaleProc>| {
        out.push(StaleProc {
            pid: p.pid,
            ppid: p.ppid,
            category: category.to_string(),
            reason,
            certain,
            name: short_name(&p.cmd),
            cmd: p.cmd.clone(),
            uptime_secs: p.uptime_secs,
            rss_mb: p.rss_kb / 1024,
        });
    };

    for p in procs.values() {
        let cmd = &p.cmd;

        // 親を失った MCP / 言語サーバー。
        if mcp.is_match(cmd) && p.ppid == 1 {
            push(p, "孤児 MCP/LSP", "親が消え init に引き取られた".into(), true, &mut out);
            continue;
        }

        if cc.is_match(cmd) {
            if let Some(c) = cask.captures(cmd) {
                let found = c.get(1).map(|m| m.as_str()).unwrap_or("");
                if let Some(cur) = &version {
                    if found != cur {
                        push(
                            p,
                            "旧版バイナリ参照",
                            format!("{found} を参照している（現行は {cur}）"),
                            true,
                            &mut out,
                        );
                        continue;
                    }
                }
            }
            if worker.is_match(cmd) && !protected.contains(&p.pid) {
                let (cat, reason, certain) = if daemon_alive {
                    ("roster 外 worker", "daemon の管理から外れている".to_string(), false)
                } else {
                    ("daemon 不在 worker", "daemon が存在しないのに残っている".to_string(), true)
                };
                push(p, cat, reason, certain, &mut out);
            }
            continue;
        }

        if protected.contains(&p.pid) || dev_exclude.is_match(cmd) {
            continue;
        }

        if let Some(gone) = missing_path(cmd, &workspace, &worktree_re) {
            push(p, "削除済みパス参照", format!("存在しないパスを参照している: {gone}"), true, &mut out);
            continue;
        }

        for (label, re) in &dev_rules {
            if re.is_match(cmd) {
                if p.ppid == 1 {
                    push(p, label, "親が存在しない".into(), true, &mut out);
                } else if p.uptime_secs >= threshold {
                    let h = p.uptime_secs / 3600;
                    let m = (p.uptime_secs % 3600) / 60;
                    push(p, label, format!("{h} 時間 {m} 分 稼働している"), false, &mut out);
                }
                break;
            }
        }
    }

    // 確実なものを先に、次に占有メモリの大きい順に見せる。
    out.sort_by(|a, b| {
        b.certain
            .cmp(&a.certain)
            .then(b.rss_mb.cmp(&a.rss_mb))
            .then(a.pid.cmp(&b.pid))
    });

    Ok(DetectResult {
        procs: out,
        protected_count: protected.len(),
        daemon_alive,
        current_version: version,
    })
}

/// 指定したプロセスを止める。まず終了を促し、残っていれば強制的に落とす。
pub fn kill_procs(pids: Vec<i32>) -> KillResult {
    let mut failed = Vec::new();
    let mut targets = Vec::new();

    for pid in pids {
        if !is_alive(pid) {
            // 検出から実行までの間に自然終了した場合は成功として扱う。
            targets.push(pid);
            continue;
        }
        if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
            targets.push(pid);
        } else {
            failed.push(KillFailure {
                pid,
                reason: "終了シグナルを送れませんでした".into(),
            });
        }
    }

    std::thread::sleep(std::time::Duration::from_secs(3));

    let mut stopped = Vec::new();
    for pid in targets {
        if !is_alive(pid) {
            stopped.push(pid);
            continue;
        }
        if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if is_alive(pid) {
                failed.push(KillFailure {
                    pid,
                    reason: "強制終了しても残っています".into(),
                });
            } else {
                stopped.push(pid);
            }
        } else {
            failed.push(KillFailure {
                pid,
                reason: "強制終了シグナルを送れませんでした".into(),
            });
        }
    }

    KillResult { stopped, failed }
}

/// 開発中に立ち上がるプロセスの種別。判定は上から順に当てる。
fn dev_kind(cmd: &str) -> Option<&'static str> {
    if cmd.contains("vitest") || cmd.contains("jest") {
        Some("テスト")
    } else if cmd.contains("eslintServer") || cmd.contains("/eslint") {
        Some("eslint")
    } else if cmd.contains("/vite") || cmd.ends_with("vite") {
        Some("Vite")
    } else if cmd.contains("tsc --build") || cmd.contains("tsc -p") || cmd.contains("webpack") {
        Some("ビルド")
    } else if cmd.contains("typescript-language-server")
        || cmd.contains("tsserver.js")
        || cmd.contains("langserver")
        || cmd.contains("pyright")
        || cmd.contains("ruff")
    {
        Some("言語サーバー")
    } else if cmd.contains("chrome-devtools-mcp")
        || cmd.contains("notion-mcp-server")
        || cmd.contains("mcp-server")
    {
        Some("MCP")
    } else if cmd.contains("playwright") {
        Some("Playwright")
    } else if cmd.contains("pytest") || cmd.contains("uv run") {
        Some("Python")
    } else if cmd.contains("typingsInstaller") {
        Some("型定義の取得")
    } else {
        None
    }
}

/// コマンドラインから、どの作業ディレクトリのものかを拾う。
fn project_of(cmd: &str, workspace: &str) -> Option<String> {
    let idx = cmd.find(workspace)?;
    let rest = &cmd[idx + workspace.len()..];
    let mut parts = rest.trim_start_matches('/').split('/');
    let first = parts.next()?;
    if first.is_empty() {
        return None;
    }
    // worktree はブランチ名まで含めた方が見分けやすい。
    let second = parts.next().unwrap_or("");
    let third = parts.next().unwrap_or("");
    if second == ".claude" && third == "worktrees" {
        if let Some(branch) = parts.next() {
            return Some(format!("{first}:{branch}"));
        }
    }
    Some(first.to_string())
}

#[derive(Debug, Serialize)]
pub struct DevProc {
    pub pid: i32,
    pub ppid: i32,
    pub kind: &'static str,
    pub name: String,
    pub cmd: String,
    /// どの作業ディレクトリのものか。
    pub project: Option<String>,
    /// 誰が起動したものか。
    pub owner: &'static str,
    pub rss_mb: u64,
    pub uptime_secs: i64,
    /// 残骸として片付けの候補に挙がるか。
    pub stale: bool,
}

#[derive(Debug, Serialize)]
pub struct DevList {
    pub procs: Vec<DevProc>,
    pub total_rss_mb: u64,
}

/// 開発中に立ち上がるプロセスを、稼働中のものも含めてすべて並べる。
///
/// 片付けの可否とは切り離し、いま何が動いているかを見るための一覧。
pub fn list_dev(hours: f64) -> Result<DevList, String> {
    let procs = read_procs()?;
    let children = build_children(&procs);
    let (protected, _) = protected_set(&procs, &children);
    let workspace = home().join("demia_works").to_string_lossy().to_string();
    let threshold = (hours * 3600.0) as i64;

    let mut out = Vec::new();
    let mut total_kb = 0u64;

    for p in procs.values() {
        let Some(kind) = dev_kind(&p.cmd) else { continue };

        let owner = if protected.contains(&p.pid) {
            "Claude"
        } else if p.cmd.contains("Application Support/Zed") || p.cmd.contains("Visual Studio Code")
        {
            "エディタ"
        } else if p.ppid == 1 {
            "親なし"
        } else {
            "その他"
        };

        // Claude が抱えているものは、そのセッションを閉じれば片付く。
        let stale = owner == "親なし" || (owner == "その他" && p.uptime_secs >= threshold);

        total_kb += p.rss_kb;
        out.push(DevProc {
            pid: p.pid,
            ppid: p.ppid,
            kind,
            name: short_name(&p.cmd),
            cmd: p.cmd.clone(),
            project: project_of(&p.cmd, &workspace),
            owner,
            rss_mb: p.rss_kb / 1024,
            uptime_secs: p.uptime_secs,
            stale,
        });
    }

    out.sort_by(|a, b| b.rss_mb.cmp(&a.rss_mb).then(a.pid.cmp(&b.pid)));

    Ok(DevList {
        procs: out,
        total_rss_mb: total_kb / 1024,
    })
}

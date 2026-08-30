use serde::Serialize;
use std::path::PathBuf;

use crate::procs;
use crate::procs::short_name;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 子プロセスが何をしているものかの見分け。
fn kind_of(cmd: &str) -> &'static str {
    if cmd.contains("chrome-devtools-mcp") {
        "ブラウザ操作"
    } else if cmd.contains("notion-mcp-server") {
        "Notion"
    } else if cmd.contains("mcp-server") || cmd.contains("mcp_server") {
        "MCP"
    } else if cmd.contains(".serena/language_servers")
        || cmd.contains("typescript-language-server")
        || cmd.contains("tsserver.js")
        || cmd.contains("langserver")
        || cmd.contains("pyright")
    {
        "言語サーバー"
    } else if cmd.contains("typingsInstaller") {
        "型定義の取得"
    } else if cmd.contains("/bin/bash") || cmd.contains("/bin/zsh") || cmd.contains("/bin/sh") {
        "シェル"
    } else {
        "その他"
    }
}

#[derive(Debug, Serialize)]
pub struct ChildProc {
    pub pid: i32,
    pub kind: &'static str,
    pub name: String,
    pub cmd: String,
    pub rss_mb: u64,
    pub uptime_secs: i64,
}

#[derive(Debug, Serialize)]
pub struct Worker {
    pub job_id: String,
    pub pid: i32,
    pub alive: bool,
    /// working / done / starting など、セッションが自分で記録している状態。
    pub state: Option<String>,
    /// 今どこを進んでいるかの短い説明。
    pub detail: Option<String>,
    /// セッションに付けられた名前。
    pub name: Option<String>,
    /// 最初に投げられた依頼。名前が無いときの手がかりになる。
    pub intent: Option<String>,
    /// active / idle など、進み具合の目安。
    pub tempo: Option<String>,
    pub tokens: Option<u64>,
    pub cwd: Option<String>,
    pub updated_at: Option<String>,
    pub uptime_secs: i64,
    /// 自分と子孫が占めているメモリの合計。
    pub rss_mb: u64,
    /// 抱えているプロセスの内訳。多い順に並べる。
    pub children: Vec<ChildProc>,
}

#[derive(Debug, Serialize)]
pub struct WorkerList {
    pub workers: Vec<Worker>,
    pub daemon_pid: Option<i32>,
    pub daemon_alive: bool,
    /// daemon 自身が占めているメモリ。
    pub daemon_rss_mb: u64,
    /// 全ワーカーとその子孫が占めるメモリの合計。
    pub total_rss_mb: u64,
}

fn read_json(path: PathBuf) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn as_string(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(|s| s.to_string())
}

/// 稼働中のバックグラウンドセッションを、状態と占有メモリつきで並べる。
pub fn list() -> Result<WorkerList, String> {
    let procs = procs::read_procs()?;
    let children_map = procs::build_children(&procs);

    let roster = read_json(home().join(".claude").join("daemon").join("roster.json"))
        .ok_or_else(|| "roster.json を読めませんでした".to_string())?;

    let daemon_pid = roster
        .get("supervisorPid")
        .and_then(|x| x.as_i64())
        .map(|x| x as i32);
    let daemon_alive = daemon_pid.map(|p| procs.contains_key(&p)).unwrap_or(false);
    let daemon_rss_mb = daemon_pid
        .and_then(|p| procs.get(&p))
        .map(|p| p.rss_kb / 1024)
        .unwrap_or(0);

    let mut workers = Vec::new();
    let mut total_rss_kb: u64 = 0;

    if let Some(map) = roster.get("workers").and_then(|w| w.as_object()) {
        for (job_id, entry) in map {
            let pid = entry.get("pid").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            let alive = procs.contains_key(&pid);

            // ワーカー本体と、それが起動した MCP や言語サーバーをまとめて数える。
            let kin = procs::descendants(pid, &children_map);
            let mut rss_kb = procs.get(&pid).map(|p| p.rss_kb).unwrap_or(0);
            let mut children = Vec::new();
            for k in &kin {
                let Some(p) = procs.get(k) else { continue };
                rss_kb += p.rss_kb;
                children.push(ChildProc {
                    pid: p.pid,
                    kind: kind_of(&p.cmd),
                    name: short_name(&p.cmd),
                    cmd: p.cmd.clone(),
                    rss_mb: p.rss_kb / 1024,
                    uptime_secs: p.uptime_secs,
                });
            }
            children.sort_by(|a, b| b.rss_mb.cmp(&a.rss_mb).then(a.pid.cmp(&b.pid)));
            total_rss_kb += rss_kb;

            let state_file = read_json(
                home()
                    .join(".claude")
                    .join("jobs")
                    .join(job_id)
                    .join("state.json"),
            );

            let (state, detail, name, intent, tempo, tokens, cwd, updated_at) = match &state_file {
                Some(v) => (
                    as_string(v, "state"),
                    as_string(v, "detail"),
                    as_string(v, "name"),
                    as_string(v, "intent"),
                    as_string(v, "tempo"),
                    v.get("tokens").and_then(|x| x.as_u64()),
                    as_string(v, "cwd"),
                    as_string(v, "updatedAt"),
                ),
                None => (None, None, None, None, None, None, None, None),
            };

            workers.push(Worker {
                job_id: job_id.clone(),
                pid,
                alive,
                state,
                detail,
                name,
                intent,
                tempo,
                tokens,
                cwd,
                updated_at,
                uptime_secs: procs.get(&pid).map(|p| p.uptime_secs).unwrap_or(0),
                rss_mb: rss_kb / 1024,
                children,
            });
        }
    }

    // 動いているものを上に、その中では占有の大きいものから見せる。
    workers.sort_by(|a, b| {
        let rank = |w: &Worker| match (w.alive, w.state.as_deref()) {
            (true, Some("working")) => 0,
            (true, _) => 1,
            (false, _) => 2,
        };
        rank(a).cmp(&rank(b)).then(b.rss_mb.cmp(&a.rss_mb))
    });

    Ok(WorkerList {
        workers,
        daemon_pid,
        daemon_alive,
        daemon_rss_mb,
        total_rss_mb: total_rss_kb / 1024,
    })
}

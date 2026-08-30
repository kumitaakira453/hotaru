use serde::Serialize;
use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct DayUsage {
    pub date: String,
    pub messages: u64,
    pub sessions: u64,
    pub tool_calls: u64,
    pub tokens: u64,
    /// Claude Code の日次集計がまだ回っていない日を、会話ログから補ったもの。
    pub provisional: bool,
}

#[derive(Debug, Serialize)]
pub struct UsageHistory {
    pub days: Vec<DayUsage>,
    pub total_sessions: u64,
    pub total_messages: u64,
    /// 履歴のうち最も多く使った日のトークン数。棒の高さを決めるのに使う。
    pub peak_tokens: u64,
    /// 期間中の 1 日あたり平均トークン。突出した日を見分ける基準になる。
    pub average_tokens: u64,
    /// 0 時から 23 時までの、時間帯ごとの記録数。
    pub hour_counts: Vec<u64>,
    pub available: bool,
}

impl UsageHistory {
    fn empty() -> Self {
        Self {
            days: Vec::new(),
            total_sessions: 0,
            total_messages: 0,
            peak_tokens: 0,
            average_tokens: 0,
            hour_counts: vec![0; 24],
            available: false,
        }
    }
}

/// 日々の使用量をまとめる。Claude Code が集計したキャッシュをそのまま読む。
/// `days` に 0 を渡すと、記録されている全期間を返す。
pub fn read(days: usize) -> UsageHistory {
    let path = home().join(".claude").join("stats-cache.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return UsageHistory::empty();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return UsageHistory::empty();
    };

    // 日付をキーにして、活動量とトークン数を突き合わせる。
    let mut by_date: std::collections::BTreeMap<String, DayUsage> = Default::default();

    if let Some(list) = v.get("dailyActivity").and_then(|x| x.as_array()) {
        for item in list {
            let Some(date) = item.get("date").and_then(|d| d.as_str()) else {
                continue;
            };
            let e = by_date.entry(date.to_string()).or_default();
            e.date = date.to_string();
            e.messages = item.get("messageCount").and_then(|x| x.as_u64()).unwrap_or(0);
            e.sessions = item.get("sessionCount").and_then(|x| x.as_u64()).unwrap_or(0);
            e.tool_calls = item
                .get("toolCallCount")
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
        }
    }

    if let Some(list) = v.get("dailyModelTokens").and_then(|x| x.as_array()) {
        for item in list {
            let Some(date) = item.get("date").and_then(|d| d.as_str()) else {
                continue;
            };
            let sum: u64 = item
                .get("tokensByModel")
                .and_then(|m| m.as_object())
                .map(|m| m.values().filter_map(|x| x.as_u64()).sum())
                .unwrap_or(0);
            let e = by_date.entry(date.to_string()).or_default();
            e.date = date.to_string();
            e.tokens = sum;
        }
    }

    // 日次集計は翌日に回るため、今日ぶんは会話ログから補う。
    let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
    if !by_date.contains_key(&today) {
        if let Some(d) = count_from_logs(&today) {
            by_date.insert(today, d);
        }
    }

    let mut rows: Vec<DayUsage> = by_date.into_values().collect();
    if days > 0 && rows.len() > days {
        rows = rows.split_off(rows.len() - days);
    }
    let peak_tokens = rows.iter().map(|d| d.tokens).max().unwrap_or(0);
    let average_tokens = if rows.is_empty() {
        0
    } else {
        rows.iter().map(|d| d.tokens).sum::<u64>() / rows.len() as u64
    };

    // 何時ごろに使っているかは時間帯別の記録から取る。
    let mut hour_counts = vec![0u64; 24];
    if let Some(map) = v.get("hourCounts").and_then(|x| x.as_object()) {
        for (k, val) in map {
            if let (Ok(h), Some(n)) = (k.parse::<usize>(), val.as_u64()) {
                if h < 24 {
                    hour_counts[h] = n;
                }
            }
        }
    }

    UsageHistory {
        days: rows,
        total_sessions: v.get("totalSessions").and_then(|x| x.as_u64()).unwrap_or(0),
        total_messages: v.get("totalMessages").and_then(|x| x.as_u64()).unwrap_or(0),
        peak_tokens,
        average_tokens,
        hour_counts,
        available: true,
    }
}

/// 会話ログから `"timestamp":"..."` の中身だけを取り出す。
///
/// 1 行ずつ JSON として読むと量が多くて待たされるため、必要な箇所だけを拾う。
fn extract_timestamp(line: &str) -> Option<&str> {
    const KEY: &str = "\"timestamp\":\"";
    let start = line.find(KEY)? + KEY.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn collect_logs(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_logs(&path, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

/// 指定した日（手元の時刻での日付）に、何時ごろ動いていたかを数える。
pub fn day_hours(date: &str) -> Result<Vec<u64>, String> {
    use chrono::{DateTime, Local, NaiveDate, TimeZone, Timelike};
    use std::io::BufRead;

    let target = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| format!("日付を読めませんでした: {e}"))?;
    let day_start = target
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).single())
        .ok_or_else(|| "日付を時刻に直せませんでした".to_string())?;
    let cutoff = day_start.timestamp();

    let mut files = Vec::new();
    collect_logs(&home().join(".claude").join("projects"), &mut files);

    let mut counts = vec![0u64; 24];
    for path in files {
        // その日の記録を含みうるのは、その日以降に触られたファイルだけ。
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if modified < cutoff {
            continue;
        }

        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            // やり取りの行だけを数える。設定や添付は対象にしない。
            if !line.contains("\"type\":\"user\"") && !line.contains("\"type\":\"assistant\"") {
                continue;
            }
            let Some(ts) = extract_timestamp(&line) else {
                continue;
            };
            let Ok(parsed) = DateTime::parse_from_rfc3339(ts) else {
                continue;
            };
            let local = parsed.with_timezone(&Local);
            if local.date_naive() == target {
                counts[local.hour() as usize] += 1;
            }
        }
    }
    Ok(counts)
}

/// 当日ぶんを会話ログから数える。
///
/// Claude Code の日次集計は翌日に回るため、今日の行はキャッシュに載らない。
/// 数え方が本家と完全に揃う保証はないので、暫定として扱う。
fn count_from_logs(date: &str) -> Option<DayUsage> {
    use chrono::{DateTime, Local, NaiveDate, TimeZone};
    use std::io::BufRead;

    let target = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let cutoff = target
        .and_hms_opt(0, 0, 0)
        .and_then(|n| Local.from_local_datetime(&n).single())?
        .timestamp();

    let mut files = Vec::new();
    collect_logs(&home().join(".claude").join("projects"), &mut files);

    let mut day = DayUsage {
        date: date.to_string(),
        provisional: true,
        ..Default::default()
    };
    let mut sessions = std::collections::HashSet::new();

    for path in files {
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if modified < cutoff {
            continue;
        }

        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut hit = false;
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let is_user = line.contains("\"type\":\"user\"");
            let is_assistant = line.contains("\"type\":\"assistant\"");
            if !is_user && !is_assistant {
                continue;
            }
            let Some(ts) = extract_timestamp(&line) else {
                continue;
            };
            let Ok(parsed) = DateTime::parse_from_rfc3339(ts) else {
                continue;
            };
            if parsed.with_timezone(&Local).date_naive() != target {
                continue;
            }

            hit = true;
            day.messages += 1;
            day.tool_calls += line.matches("\"type\":\"tool_use\"").count() as u64;

            if is_assistant {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                        for k in [
                            "input_tokens",
                            "output_tokens",
                            "cache_creation_input_tokens",
                            "cache_read_input_tokens",
                        ] {
                            day.tokens += u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                        }
                    }
                }
            }
        }
        if hit {
            sessions.insert(path.file_stem().map(|s| s.to_string_lossy().to_string()));
        }
    }

    day.sessions = sessions.len() as u64;
    if day.messages == 0 {
        None
    } else {
        Some(day)
    }
}

/// モデルひとつぶんの消費。
#[derive(Debug, Serialize, Default, Clone)]
pub struct ModelUse {
    /// ログに記録されている識別子。
    pub model: String,
    /// 画面に出す呼び名。
    pub label: String,
    pub messages: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// 通した文字の合計。キャッシュの読み書きも含む。
    pub tokens: u64,
}

/// `claude-haiku-4-5-20251001` のような識別子を `Haiku 4.5` に均す。
fn label_of(model: &str) -> String {
    let body = model.strip_prefix("claude-").unwrap_or(model);
    // 版に付く括弧書きと日付は呼び名に要らない。
    let body = body.split('[').next().unwrap_or(body);
    let parts: Vec<&str> = body
        .split('-')
        .filter(|p| !(p.len() == 8 && p.chars().all(|c| c.is_ascii_digit())))
        .filter(|p| !p.is_empty())
        .collect();
    let Some((family, version)) = parts.split_first() else {
        return model.to_string();
    };
    let mut name = String::new();
    let mut chars = family.chars();
    if let Some(c) = chars.next() {
        name.extend(c.to_uppercase());
        name.push_str(chars.as_str());
    }
    if version.is_empty() {
        name
    } else {
        format!("{name} {}", version.join("."))
    }
}

/// 指定した時刻以降に、どのモデルをどれだけ使ったかを会話ログから数える。
///
/// 5 時間枠の始まりを渡せば、いま消費している枠の内訳がそのまま出る。
pub fn model_usage(since: i64) -> Result<Vec<ModelUse>, String> {
    use chrono::DateTime;
    use std::collections::HashMap;
    use std::io::BufRead;

    let mut files = Vec::new();
    collect_logs(&home().join(".claude").join("projects"), &mut files);

    let mut acc: HashMap<String, ModelUse> = HashMap::new();
    for path in files {
        // その時刻以降の記録を含みうるのは、以降に触られたファイルだけ。
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if modified < since {
            continue;
        }

        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            // 消費が載るのは応答の行だけ。全文を解く前に絞る。
            if !line.contains("\"type\":\"assistant\"") {
                continue;
            }
            let Some(ts) = extract_timestamp(&line) else {
                continue;
            };
            let Ok(parsed) = DateTime::parse_from_rfc3339(ts) else {
                continue;
            };
            if parsed.timestamp() < since {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let message = &value["message"];
            let Some(model) = message["model"].as_str() else {
                continue;
            };
            let usage = &message["usage"];
            let field = |key: &str| usage[key].as_u64().unwrap_or(0);

            let entry = acc.entry(model.to_string()).or_insert_with(|| ModelUse {
                model: model.to_string(),
                label: label_of(model),
                ..Default::default()
            });
            entry.messages += 1;
            entry.input += field("input_tokens");
            entry.output += field("output_tokens");
            entry.cache_read += field("cache_read_input_tokens");
            entry.cache_write += field("cache_creation_input_tokens");
        }
    }

    let mut list: Vec<ModelUse> = acc.into_values().collect();
    for m in &mut list {
        m.tokens = m.input + m.output + m.cache_read + m.cache_write;
    }
    list.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.label.cmp(&b.label)));
    Ok(list)
}

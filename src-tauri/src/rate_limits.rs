use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::usage_api::{self, ExtraUsage};

/// 取りに行った結果を短時間だけ使い回す。窓と小窓と定期取得が
/// 同じ間隔で呼ぶため、そのたびに叩くと無駄に多くなる。
const MEMO_SECS: i64 = 10;
static MEMO: Mutex<Option<(i64, RateLimits)>> = Mutex::new(None);

/// 5 時間枠の長さ。
const FIVE_HOUR: i64 = 5 * 3600;
/// 7 日枠の長さ。
const SEVEN_DAY: i64 = 7 * 86400;
/// 枠が始まって間もないうちは、わずかな使用量でも見込みが大きく振れる。
/// この割合を過ぎるまでは暫定として扱う。
const PROJECTION_FLOOR: f64 = 0.08;
/// これより短い経過では割り算が成立しないため、見込み自体を出さない。
const MIN_ELAPSED_SECS: i64 = 60;

/// statusline から書き出されたキャッシュの場所。
fn cache_path() -> PathBuf {
    home().join(".claude").join("rate-limits.json")
}

/// statusline スクリプトの場所。書き出しが仕込まれているかの判定に使う。
fn statusline_path() -> PathBuf {
    home().join(".claude").join("statusline.sh")
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// statusline に書き出し処理が入っているかを見分ける目印。
pub const WIRE_MARKER: &str = "hotaru:rate-limits";

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct RawWindow {
    used_percentage: Option<f64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawLimits {
    five_hour: Option<RawWindow>,
    seven_day: Option<RawWindow>,
    spend_limit: Option<RawWindow>,
}

#[derive(Debug, Deserialize)]
struct RawCache {
    captured_at: Option<i64>,
    rate_limits: Option<RawLimits>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Window {
    /// 0〜100。上限を超えると 100 を上回ることがある。
    pub used_percentage: f64,
    pub resets_at: i64,
    /// リセットまでの残り秒。
    pub resets_in_secs: i64,
    /// 枠の長さ。長さが決まっていない枠では None。
    pub window_secs: Option<i64>,
    /// 枠が始まった時刻。
    pub started_at: Option<i64>,
    /// 枠のうち経過した割合（0〜1）。使用率と比べるとペースの速さが分かる。
    pub elapsed_ratio: Option<f64>,
    /// 今のペースを保った場合に 100% へ達する時刻。
    pub projected_full_at: Option<i64>,
    /// 今のペースを保った場合、リセット時点で到達している使用率。100 を超えうる。
    pub projected_at_reset: Option<f64>,
    /// リセットより先に使い切る見込みなら true。
    pub exhausts_before_reset: bool,
    /// 枠が浅く、見込みがまだ大きく振れる段階なら true。
    pub provisional: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RateLimits {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    /// 支払い枠の使用率。上限が設定されているときだけ入る。
    pub spend_percentage: Option<f64>,
    /// 上限に達したあとに使える追加分。
    pub extra: Option<ExtraUsage>,
    /// どこから取れた値か。"live" は取りに行った結果、"cache" は statusline の書き置き。
    pub source: &'static str,
    /// キャッシュが書かれた時刻。source が "cache" のときだけ意味がある。
    pub captured_at: Option<i64>,
    /// キャッシュの古さ（秒）。
    pub age_secs: Option<i64>,
    /// 値が得られたか。
    pub available: bool,
    /// statusline に書き出しが仕込まれているか。false なら設定を促す。
    pub statusline_wired: bool,
}

impl RateLimits {
    fn empty(statusline_wired: bool) -> Self {
        Self {
            five_hour: None,
            seven_day: None,
            spend_percentage: None,
            extra: None,
            source: "cache",
            captured_at: None,
            age_secs: None,
            available: false,
            statusline_wired,
        }
    }
}

/// 枠の情報から到達見込みを組み立てる。
///
/// resets_at を過ぎたウィンドウは Claude Code 側でも落とされるため、
/// キャッシュに残っていても期限切れとして扱う。
fn to_window(raw: Option<RawWindow>, now: i64, window_secs: Option<i64>) -> Option<Window> {
    let raw = raw?;
    let used = raw.used_percentage?;
    let resets_at = raw.resets_at?;
    if resets_at <= now {
        return None;
    }

    let started_at = window_secs.map(|w| resets_at - w);
    let elapsed_ratio = match (started_at, window_secs) {
        (Some(start), Some(w)) if w > 0 => Some(((now - start) as f64 / w as f64).clamp(0.0, 1.0)),
        _ => None,
    };

    // 消費ペース。枠が浅いうちは値が振れるため、暫定であることを添えて返す。
    let elapsed_secs = started_at.map(|start| now - start).unwrap_or(0);
    let pace = if elapsed_secs >= MIN_ELAPSED_SECS {
        Some(used / elapsed_secs as f64)
    } else {
        None
    };
    let provisional = match window_secs {
        Some(w) if w > 0 => (elapsed_secs as f64) < w as f64 * PROJECTION_FLOOR,
        _ => false,
    };

    // 今のペースのまま 100% に届く時刻。
    let projected_full_at = match pace {
        Some(p) if p > 0.0 && used < 100.0 => Some(now + ((100.0 - used) / p) as i64),
        _ => None,
    };

    // 枠が終わる時点まで同じ調子で使い続けたら、どこまで届くか。
    let projected_at_reset = match (pace, window_secs) {
        (Some(p), Some(w)) => Some(p * w as f64),
        _ => None,
    };

    let exhausts_before_reset = used >= 100.0
        || projected_full_at
            .map(|full| full < resets_at)
            .unwrap_or(false);

    Some(Window {
        used_percentage: used,
        resets_at,
        resets_in_secs: resets_at - now,
        window_secs,
        started_at,
        elapsed_ratio,
        projected_full_at,
        projected_at_reset,
        exhausts_before_reset,
        provisional,
    })
}

fn is_wired() -> bool {
    std::fs::read_to_string(statusline_path())
        .map(|s| s.contains(WIRE_MARKER))
        .unwrap_or(false)
}

/// 使用状況を返す。
///
/// まず取りに行き、届かなければ statusline の書き置きへ戻す。取りに行く経路は
/// 文書化されていないため、いつ壊れても表示が止まらないようにしてある。
pub fn read() -> RateLimits {
    let now = now_secs();
    {
        let memo = MEMO.lock().unwrap();
        if let Some((at, value)) = memo.as_ref() {
            if now - at < MEMO_SECS {
                return value.clone();
            }
        }
    }

    let value = read_live().unwrap_or_else(read_cache);
    *MEMO.lock().unwrap() = Some((now, value.clone()));
    value
}

/// 取りに行った結果を、キャッシュと同じ形へ組み替える。
fn read_live() -> Option<RateLimits> {
    let live = usage_api::fetch()?;
    let now = now_secs();
    let as_raw = |v: Option<(f64, i64)>| {
        v.map(|(used, resets_at)| RawWindow {
            used_percentage: Some(used),
            resets_at: Some(resets_at),
        })
    };

    Some(RateLimits {
        five_hour: to_window(as_raw(live.five_hour), now, Some(FIVE_HOUR)),
        seven_day: to_window(as_raw(live.seven_day), now, Some(SEVEN_DAY)),
        spend_percentage: live.spend_percentage,
        extra: live.extra,
        source: "live",
        captured_at: Some(now),
        age_secs: Some(0),
        available: true,
        statusline_wired: is_wired(),
    })
}

/// statusline が書き置いたキャッシュを読む。ファイルが無い場合や壊れている場合も
/// エラーにせず available=false で返し、UI 側で理由を出せるようにする。
fn read_cache() -> RateLimits {
    let wired = is_wired();
    let text = match std::fs::read_to_string(cache_path()) {
        Ok(t) => t,
        Err(_) => return RateLimits::empty(wired),
    };
    let raw: RawCache = match serde_json::from_str(&text) {
        Ok(r) => r,
        Err(_) => return RateLimits::empty(wired),
    };

    let now = now_secs();
    let (five, seven, spend) = match raw.rate_limits {
        Some(l) => (
            to_window(l.five_hour, now, Some(FIVE_HOUR)),
            to_window(l.seven_day, now, Some(SEVEN_DAY)),
            // 支払い枠は期間が一定でないため、経過や見込みは出さない。
            to_window(l.spend_limit, now, None),
        ),
        None => (None, None, None),
    };

    RateLimits {
        five_hour: five,
        seven_day: seven,
        spend_percentage: spend.map(|w| w.used_percentage),
        extra: None,
        source: "cache",
        captured_at: raw.captured_at,
        age_secs: raw.captured_at.map(|c| (now - c).max(0)),
        available: true,
        statusline_wired: wired,
    }
}

/// statusline に使用状況の書き出しを差し込む。
///
/// Claude Code は statusline へ渡す JSON にのみ rate_limits を載せるため、
/// 受け取った値をファイルに残さないと常駐アプリから読めない。
pub fn wire() -> Result<String, String> {
    let path = statusline_path();
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("statusline.sh を読めませんでした: {e}"))?;

    if text.contains(WIRE_MARKER) {
        return Ok("すでに設定されています".to_string());
    }

    let anchor = "input=$(cat)";
    if !text.contains(anchor) {
        return Err(
            "statusline.sh に `input=$(cat)` が見つからないため、自動では追記できません".into(),
        );
    }

    let snippet = format!(
        "{anchor}\n\n# {marker}\n\
         # 受け取った使用状況をメニューバーアプリと共有する\n\
         printf '%s' \"$input\" | jq -c --argjson t \"$(date +%s)\" \\\n  \
         '{{captured_at: $t, rate_limits: (.rate_limits // {{}})}}' \\\n  \
         > \"$HOME/.claude/rate-limits.json\"\n",
        anchor = anchor,
        marker = WIRE_MARKER,
    );

    let updated = text.replacen(anchor, &snippet, 1);
    std::fs::write(&path, updated)
        .map_err(|e| format!("statusline.sh を書き換えられませんでした: {e}"))?;
    Ok("statusline に書き出しを追加しました".to_string())
}

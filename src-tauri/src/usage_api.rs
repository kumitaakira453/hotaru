//! Claude Code の資格情報を借りて、使用状況を能動的に取りに行く。
//!
//! statusline のキャッシュはセッションがプロンプトを処理した瞬間にしか
//! 更新されないため、しばらく使っていないと値が古いまま残る。こちらは
//! 押した時点の値が取れる代わりに、**文書化されていない経路**なので
//! 失敗を前提に扱い、呼び出し側でキャッシュへ戻せるようにしてある。

use serde::Deserialize;
use std::io::Write;
use std::process::{Command, Stdio};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Claude Code が資格情報を置いている Keychain の項目。
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const TIMEOUT_SECS: u32 = 8;

#[derive(Deserialize)]
struct Cred {
    #[serde(rename = "claudeAiOauth")]
    oauth: Oauth,
}

#[derive(Deserialize)]
struct Oauth {
    #[serde(rename = "accessToken")]
    access_token: String,
}

/// Keychain から資格情報を取り出す。
///
/// 期限切れでも黙って返す。使えるかどうかは実際に叩いた結果で判断する。
/// 自前で更新はしない。更新すると値が入れ替わり、Claude Code 側の
/// 認証状態を壊しかねないため。
fn credential() -> Option<String> {
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let cred: Cred = serde_json::from_slice(out.stdout.trim_ascii()).ok()?;
    Some(cred.oauth.access_token)
}

#[derive(Debug, Deserialize)]
struct ApiWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiModel {
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiScope {
    model: Option<ApiModel>,
}

#[derive(Debug, Deserialize)]
struct ApiLimit {
    kind: Option<String>,
    percent: Option<f64>,
    resets_at: Option<String>,
    scope: Option<ApiScope>,
}

#[derive(Debug, Deserialize)]
struct ApiMoney {
    amount_minor: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ApiSpend {
    percent: Option<f64>,
    enabled: Option<bool>,
    limit: Option<ApiMoney>,
}

#[derive(Debug, Deserialize)]
struct ApiExtra {
    is_enabled: Option<bool>,
    monthly_limit: Option<f64>,
    used_credits: Option<f64>,
    currency: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiUsage {
    five_hour: Option<ApiWindow>,
    seven_day: Option<ApiWindow>,
    limits: Option<Vec<ApiLimit>>,
    spend: Option<ApiSpend>,
    extra_usage: Option<ApiExtra>,
}

/// モデルごとに分かれた週次の枠。プランによって出たり出なかったりする。
#[derive(Debug, serde::Serialize, Clone, PartialEq)]
pub struct ScopedLimit {
    /// 「Opus」「Sonnet」など、枠が対応するモデルの呼び名。
    pub label: String,
    pub percent: f64,
    pub resets_at: Option<i64>,
}

/// 上限に達したあとに使える追加分。
#[derive(Debug, serde::Serialize, Clone, PartialEq)]
pub struct ExtraUsage {
    pub used_credits: f64,
    pub monthly_limit: f64,
    pub currency: String,
}

/// 能動取得の結果。呼び出し側が既存の形へ組み替える。
#[derive(Debug)]
pub struct Live {
    /// 使用率とリセット時刻の組。
    pub five_hour: Option<(f64, i64)>,
    pub seven_day: Option<(f64, i64)>,
    pub spend_percentage: Option<f64>,
    pub scoped: Vec<ScopedLimit>,
    pub extra: Option<ExtraUsage>,
}

fn epoch_of(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp())
}

fn window_of(w: Option<ApiWindow>) -> Option<(f64, i64)> {
    let w = w?;
    Some((w.utilization?, epoch_of(w.resets_at.as_deref()?)?))
}

/// 使用状況を取りに行く。取れなければ None を返し、呼び出し側でキャッシュへ戻す。
pub fn fetch() -> Option<Live> {
    let raw = request(&credential()?)?;

    // モデル別の枠は limits の中に混ざって届く。呼び名が付いているものだけ拾う。
    let scoped = raw
        .limits
        .unwrap_or_default()
        .into_iter()
        .filter(|l| l.kind.as_deref() == Some("weekly_scoped"))
        .filter_map(|l| {
            let label = l.scope?.model?.display_name?;
            Some(ScopedLimit {
                label,
                percent: l.percent.unwrap_or(0.0),
                resets_at: l.resets_at.as_deref().and_then(epoch_of),
            })
        })
        .collect();

    // 上限が決まっていない支払い枠は、割合を出しても読み取れないので伏せる。
    let spend_percentage = raw.spend.and_then(|s| {
        let has_limit = s.limit.and_then(|m| m.amount_minor).unwrap_or(0) > 0;
        if s.enabled.unwrap_or(false) && has_limit {
            s.percent
        } else {
            None
        }
    });

    let extra = raw.extra_usage.and_then(|e| {
        let limit = e.monthly_limit.unwrap_or(0.0);
        let used = e.used_credits.unwrap_or(0.0);
        if !e.is_enabled.unwrap_or(false) || (limit <= 0.0 && used <= 0.0) {
            return None;
        }
        Some(ExtraUsage {
            used_credits: used,
            monthly_limit: limit,
            currency: e.currency.unwrap_or_else(|| "USD".to_string()),
        })
    });

    Some(Live {
        five_hour: window_of(raw.five_hour),
        seven_day: window_of(raw.seven_day),
        spend_percentage,
        scoped,
        extra,
    })
}

/// 値を引数に置くと `ps` から覗けてしまうため、curl の設定として
/// 標準入力から渡す。`fail` を付けて拒否を終了コードで受け取る。
fn request(auth: &str) -> Option<ApiUsage> {
    let mut child = Command::new("/usr/bin/curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    child
        .stdin
        .take()?
        .write_all(
            format!(
                "url = \"{USAGE_URL}\"\n\
                 header = \"Authorization: Bearer {auth}\"\n\
                 silent\n\
                 fail\n\
                 max-time = {TIMEOUT_SECS}\n"
            )
            .as_bytes(),
        )
        .ok()?;

    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

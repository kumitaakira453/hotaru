export type LimitWindow = {
  used_percentage: number;
  resets_at: number;
  resets_in_secs: number;
  /** 枠の長さ。長さが決まっていない枠では null。 */
  window_secs: number | null;
  started_at: number | null;
  /** 枠のうち経過した割合（0〜1）。 */
  elapsed_ratio: number | null;
  /** 今のペースを保った場合に 100% へ達する時刻。 */
  projected_full_at: number | null;
  /** 今のペースを保った場合、リセット時点で到達している使用率。 */
  projected_at_reset: number | null;
  /** リセットより先に使い切る見込みか。 */
  exhausts_before_reset: boolean;
  /** 枠が浅く、見込みがまだ大きく振れる段階か。 */
  provisional: boolean;
};

/** モデルごとに分かれた週次の枠。 */
export type ScopedLimit = {
  label: string;
  percent: number;
  resets_at: number | null;
};

/** 上限に達したあとに使える追加分。 */
export type ExtraUsage = {
  used_credits: number;
  monthly_limit: number;
  currency: string;
};

export type RateLimits = {
  five_hour: LimitWindow | null;
  seven_day: LimitWindow | null;
  /** 支払い枠の使用率。上限が設定されているときだけ入る。 */
  spend_percentage: number | null;
  scoped: ScopedLimit[];
  extra: ExtraUsage | null;
  /** "live" は取りに行った結果、"cache" は statusline の書き置き。 */
  source: "live" | "cache";
  captured_at: number | null;
  age_secs: number | null;
  available: boolean;
  statusline_wired: boolean;
};

export type StaleProc = {
  pid: number;
  ppid: number;
  category: string;
  reason: string;
  certain: boolean;
  name: string;
  cmd: string;
  uptime_secs: number;
  rss_mb: number;
};

export type DetectResult = {
  procs: StaleProc[];
  protected_count: number;
  daemon_alive: boolean;
  current_version: string | null;
};

export type KillResult = {
  stopped: number[];
  failed: { pid: number; reason: string }[];
};

export type DayUsage = {
  date: string;
  messages: number;
  sessions: number;
  tool_calls: number;
  tokens: number;
  /** 日次集計がまだ回っておらず、会話ログから補った日か。 */
  provisional: boolean;
};

export type UsageHistory = {
  days: DayUsage[];
  total_sessions: number;
  total_messages: number;
  peak_tokens: number;
  average_tokens: number;
  hour_counts: number[];
  available: boolean;
};

export type ChildProc = {
  pid: number;
  kind: string;
  name: string;
  cmd: string;
  rss_mb: number;
  uptime_secs: number;
};

export type Worker = {
  job_id: string;
  pid: number;
  alive: boolean;
  state: string | null;
  detail: string | null;
  name: string | null;
  intent: string | null;
  tempo: string | null;
  tokens: number | null;
  cwd: string | null;
  updated_at: string | null;
  uptime_secs: number;
  rss_mb: number;
  children: ChildProc[];
};

export type WorkerList = {
  workers: Worker[];
  daemon_pid: number | null;
  daemon_alive: boolean;
  daemon_rss_mb: number;
  total_rss_mb: number;
};

export type DevProc = {
  pid: number;
  ppid: number;
  kind: string;
  name: string;
  cmd: string;
  project: string | null;
  owner: string;
  rss_mb: number;
  uptime_secs: number;
  stale: boolean;
};

export type DevList = {
  procs: DevProc[];
  total_rss_mb: number;
};

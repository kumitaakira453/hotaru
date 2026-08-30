import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { DayUsage, UsageHistory } from "../types";

const PERIODS: { days: number; label: string }[] = [
  { days: 7, label: "7日" },
  { days: 14, label: "14日" },
  { days: 30, label: "30日" },
  { days: 0, label: "全期間" },
];

/** 棒をなぞっている間に何度も集計しないよう、落ち着くまで待つ。 */
const HOVER_SETTLE_MS = 180;

function shortTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function weekdayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return "日月火水木金土"[d.getDay()] ?? "";
}

function isToday(iso: string): boolean {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return iso === today;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${Math.round(n)}%`;
}

type Props = {
  history: UsageHistory | null;
  period: number;
  onPeriodChange: (days: number) => void;
  /** 履歴そのものを取り直している最中か。 */
  loading: boolean;
};

export function UsageChart({ history, period, onPeriodChange, loading }: Props) {
  // 最後に指した日を覚えておく。離れても見ていた日のままにする。
  const [picked, setPicked] = useState<string | null>(null);
  // どの日の集計かを一緒に持ち、選んでいる日と一致した時だけ使う。
  const [hourData, setHourData] = useState<{ date: string; hours: number[] } | null>(null);
  const [hourLoading, setHourLoading] = useState(false);
  const [hourError, setHourError] = useState<string | null>(null);

  const days = history?.days ?? [];
  const index = Math.max(0, picked ? days.findIndex((d) => d.date === picked) : days.length - 1);
  const shownDate = days[index]?.date ?? null;

  // 選んだ日の時間帯は会話ログから数える。件数が多いので少し待ってから走らせる。
  useEffect(() => {
    if (!shownDate) return;
    let cancelled = false;
    setHourLoading(true);
    setHourError(null);
    const timer = window.setTimeout(() => {
      void invoke<number[]>("read_day_hours", { date: shownDate })
        .then((h) => {
          if (!cancelled) setHourData({ date: shownDate, hours: h });
        })
        .catch((e) => {
          if (!cancelled) {
            setHourData(null);
            setHourError(String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setHourLoading(false);
        });
    }, HOVER_SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shownDate]);

  const selector = (
    <div className="subtabs">
      {PERIODS.map((p) => (
        <button
          key={p.days}
          className={period === p.days ? "on" : ""}
          onClick={() => onPeriodChange(p.days)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );

  if (!history || !history.available || days.length === 0) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">使用履歴</h2>
        </div>
        {selector}
        <p className="empty">記録がまだありません</p>
      </section>
    );
  }

  const { peak_tokens, average_tokens } = history;
  const shown: DayUsage = days[index];
  const prev = index > 0 ? days[index - 1] : null;

  const vsAverage = average_tokens > 0 ? (shown.tokens / average_tokens - 1) * 100 : 0;
  const vsPrev = prev && prev.tokens > 0 ? (shown.tokens / prev.tokens - 1) * 100 : null;

  // 表示している日の集計だけを使う。揃っていなければ数字を出さない。
  const fresh = hourData?.date === shown.date ? hourData.hours : null;
  const hasRecord = fresh != null && fresh.some((n) => n > 0);
  const hourMax = fresh ? Math.max(...fresh, 1) : 1;
  const peakHour = fresh ? fresh.indexOf(Math.max(...fresh)) : -1;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">使用履歴</h2>
        <span className="panel-note">
          {loading ? (
            <>
              <span className="hours-spinner" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              読み込み中
            </>
          ) : (
            `1 日あたり平均 ${shortTokens(average_tokens)}`
          )}
        </span>
      </div>

      {selector}

      <div className={"chart" + (loading ? " loading" : "")}>
        {/* 平均の高さに線を置くと、どの日が跳ねているかがそのまま見える */}
        {peak_tokens > 0 && average_tokens > 0 && (
          <div
            className="chart-average"
            style={{ bottom: `${(average_tokens / peak_tokens) * 100}%` }}
          />
        )}
        {days.map((d, i) => {
          const ratio = peak_tokens > 0 ? d.tokens / peak_tokens : 0;
          return (
            <button
              key={d.date}
              style={{ ["--i" as string]: i }}
              className={
                "bar-slot" + (d.date === shown.date ? " active" : "")
              }
              onMouseEnter={() => setPicked(d.date)}
              onFocus={() => setPicked(d.date)}
              aria-label={`${shortDate(d.date)} ${shortTokens(d.tokens)} トークン`}
            >
              <span className="bar" style={{ height: `${Math.max(ratio * 100, 2)}%` }} />
            </button>
          );
        })}
      </div>

      <div className="chart-axis">
        <span>{shortDate(days[0].date)}</span>
        <span className="muted">破線は平均</span>
        <span>{shortDate(days[days.length - 1].date)}</span>
      </div>

      {/* 指した日の内訳。棒だけでは読めない数値をここで見せる */}
      <div className="day-card">
        <div className="day-head">
          <span className="day-date">
            {shortDate(shown.date)}
            <span className="muted">（{weekdayOf(shown.date)}）</span>
            {isToday(shown.date) && <span className="day-today">今日</span>}
            {shown.provisional && (
              <span className="day-tent" title="日次集計がまだ回っていないため会話ログから数えた値">
                暫定
              </span>
            )}
          </span>
          <span className="day-tokens">{shortTokens(shown.tokens)}</span>
        </div>

        <div className="day-compare">
          <span className={vsAverage >= 0 ? "up" : "down"}>平均比 {signed(vsAverage)}</span>
          {vsPrev !== null && (
            <span className={vsPrev >= 0 ? "up" : "down"}>前日比 {signed(vsPrev)}</span>
          )}
        </div>

        <dl className="day-stats">
          <div>
            <dt>メッセージ</dt>
            <dd>{shown.messages.toLocaleString()}</dd>
          </div>
          <div>
            <dt>ツール呼び出し</dt>
            <dd>{shown.tool_calls.toLocaleString()}</dd>
          </div>
          <div>
            <dt>セッション</dt>
            <dd>{shown.sessions.toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      {/* その日のどの時間に動いていたか。集計が揃うまでは数字を出さない */}
      <div className="hours">
        <div className="hours-head">
          <span>{shortDate(shown.date)} の時間帯</span>
          <span className="muted">
            {hourLoading ? (
              <>
                <span className="hours-spinner" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                集計中
              </>
            ) : hourError
                ? "集計できませんでした"
                : hasRecord
                  ? `${peakHour}時ごろが最多`
                  : "記録なし"}
          </span>
        </div>
        <div className={"hours-chart" + (hourLoading ? " loading" : "")}>
          {(fresh ?? Array(24).fill(0)).map((n, h) => (
            <span
              key={h}
              className={"hour" + (hasRecord && h === peakHour ? " peak" : "")}
              style={{
                ["--i" as string]: h,
                height: hasRecord ? `${Math.max((n / hourMax) * 100, 3)}%` : "3%",
              }}
              title={`${h}時 ${n.toLocaleString()}`}
            />
          ))}
        </div>
        <div className="hours-axis">
          <span>0時</span>
          <span>6時</span>
          <span>12時</span>
          <span>18時</span>
          <span>23時</span>
        </div>
      </div>
    </section>
  );
}

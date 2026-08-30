import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { DayUsage, UsageHistory } from "../types";

const PERIODS: { days: number; label: string }[] = [
  { days: 7, label: "7日" },
  { days: 14, label: "14日" },
  { days: 30, label: "30日" },
  { days: 0, label: "全期間" },
];

/** 平均のこの倍を超えた日は、突出した日として色を変える。 */
const SPIKE_RATIO = 1.5;

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
};

export function UsageChart({ history, period, onPeriodChange }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [dayHours, setDayHours] = useState<number[] | null>(null);

  const days = history?.days ?? [];
  const index = Math.max(0, hovered ? days.findIndex((d) => d.date === hovered) : days.length - 1);
  const shownDate = days[index]?.date ?? null;

  // 選んだ日の時間帯は会話ログから数える。集計が返るまでは前の値を残す。
  useEffect(() => {
    if (!shownDate) return;
    let cancelled = false;
    void invoke<number[]>("read_day_hours", { date: shownDate })
      .then((h) => {
        if (!cancelled) setDayHours(h);
      })
      .catch(() => {
        if (!cancelled) setDayHours(null);
      });
    return () => {
      cancelled = true;
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

  const { peak_tokens, average_tokens, hour_counts } = history;
  const shown: DayUsage = days[index];
  const prev = index > 0 ? days[index - 1] : null;

  const vsAverage = average_tokens > 0 ? (shown.tokens / average_tokens - 1) * 100 : 0;
  const vsPrev = prev && prev.tokens > 0 ? (shown.tokens / prev.tokens - 1) * 100 : null;
  const spikes = days.filter((d) => average_tokens > 0 && d.tokens > average_tokens * SPIKE_RATIO);

  // 選んだ日の集計が取れていればそちらを、無ければ全期間の傾向を出す。
  const perDay = dayHours != null && dayHours.some((n) => n > 0);
  const hours = perDay ? dayHours! : hour_counts;
  const peakHour = hours.indexOf(Math.max(...hours));
  const hourMax = Math.max(...hours, 1);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">使用履歴</h2>
        <span className="panel-note">1 日あたり平均 {shortTokens(average_tokens)}</span>
      </div>

      {selector}

      <div className="chart" onMouseLeave={() => setHovered(null)}>
        {/* 平均の高さに線を置くと、どの日が跳ねているかがそのまま見える */}
        {peak_tokens > 0 && average_tokens > 0 && (
          <div
            className="chart-average"
            style={{ bottom: `${(average_tokens / peak_tokens) * 100}%` }}
          />
        )}
        {days.map((d) => {
          const ratio = peak_tokens > 0 ? d.tokens / peak_tokens : 0;
          const spike = average_tokens > 0 && d.tokens > average_tokens * SPIKE_RATIO;
          return (
            <button
              key={d.date}
              className={
                "bar-slot" +
                (d.date === shown.date ? " active" : "") +
                (isToday(d.date) ? " today" : "") +
                (spike ? " spike" : "")
              }
              onMouseEnter={() => setHovered(d.date)}
              onFocus={() => setHovered(d.date)}
              aria-label={`${shortDate(d.date)} ${shortTokens(d.tokens)} トークン`}
            >
              <span className="bar" style={{ height: `${Math.max(ratio * 100, 2)}%` }} />
            </button>
          );
        })}
      </div>

      <div className="chart-axis">
        <span>{shortDate(days[0].date)}</span>
        <span className="muted">
          破線は平均
          {spikes.length > 0 ? ` / 大きく超えた日 ${spikes.length}` : ""}
        </span>
        <span>{shortDate(days[days.length - 1].date)}</span>
      </div>

      {/* 指した日の内訳。棒だけでは読めない数値をここで見せる */}
      <div className="day-card">
        <div className="day-head">
          <span className="day-date">
            {shortDate(shown.date)}
            <span className="muted">（{weekdayOf(shown.date)}）</span>
            {isToday(shown.date) && <span className="day-today">今日</span>}
          </span>
          <span className="day-tokens">{shortTokens(shown.tokens)}</span>
        </div>

        <div className="day-compare">
          <span className={vsAverage >= 0 ? "up" : "down"}>平均比 {signed(vsAverage)}</span>
          {vsPrev !== null && (
            <span className={vsPrev >= 0 ? "up" : "down"}>前日比 {signed(vsPrev)}</span>
          )}
          {average_tokens > 0 && shown.tokens > average_tokens * SPIKE_RATIO && (
            <span className="day-spike">よく使った日</span>
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

      {/* その日のどの時間に動いていたか */}
      <div className="hours">
        <div className="hours-head">
          <span>
            {perDay ? `${shortDate(shown.date)} の時間帯` : "よく使う時間帯"}
            {!perDay && <span className="muted"> 全期間の傾向</span>}
          </span>
          <span className="muted">
            {hours[peakHour] > 0 ? `${peakHour}時ごろが最多` : "記録なし"}
          </span>
        </div>
        <div className="hours-chart">
          {hours.map((n, h) => (
            <span
              key={h}
              className={"hour" + (h === peakHour && n > 0 ? " peak" : "")}
              style={{ height: `${Math.max((n / hourMax) * 100, 3)}%` }}
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

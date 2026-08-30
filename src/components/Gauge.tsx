import { useEffect, useState } from "react";
import type { LimitWindow } from "../types";

const SIZE = 124;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// 使用率の帯ごとの色。メニューバーのアイコンと同じ移り変わりにする。
function hueFor(pct: number): string {
  if (pct < 55) return "var(--calm)";
  if (pct < 85) return "var(--warm)";
  return "var(--hot)";
}

/** 何時にリセットされるかを、今日中なら時刻だけで示す。 */
function clockOf(epoch: number): string {
  const d = new Date(epoch * 1000);
  const now = new Date();
  const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hhmm;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  if (isTomorrow) return `明日 ${hhmm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

function durationOf(secs: number): string {
  if (secs <= 0) return "まもなく";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}日${h}時間`;
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.4V8l2.6 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function VerdictIcon({ warn }: { warn: boolean }) {
  return warn ? (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 1.8 15 14H1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 6.2v3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.2 8.2 7.2 10.2 10.9 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Props = {
  label: string;
  /** 輪の中に出す短い呼び名。 */
  short: string;
  hint: string;
  window: LimitWindow | null;
};

export function Gauge({ label, short, hint, window: w }: Props) {
  // 開いた瞬間に 0 から伸ばして、値の大きさを動きで感じられるようにする。
  const [shown, setShown] = useState(0);
  const target = w ? Math.min(w.used_percentage, 100) : 0;

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(target));
    return () => cancelAnimationFrame(id);
  }, [target]);

  const color = hueFor(target);
  const offset = CIRCUMFERENCE * (1 - shown / 100);
  const elapsedPct = w?.elapsed_ratio != null ? w.elapsed_ratio * 100 : null;
  const projected = w?.projected_at_reset ?? null;
  // 見込みの弧は現在値より先の部分だけを淡く重ねる。
  const projectedCapped = projected != null ? Math.min(projected, 100) : null;
  const projectedOffset =
    projectedCapped != null ? CIRCUMFERENCE * (1 - projectedCapped / 100) : null;

  return (
    <section className="gauge">
      <div className="gauge-ring">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle
            className="gauge-track"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            strokeWidth={STROKE}
          />
          {projectedOffset != null && (
            <circle
              className="gauge-projected"
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              strokeWidth={STROKE}
              stroke={color}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={projectedOffset}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          )}
          {w && (
            <circle
              className="gauge-value"
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              strokeWidth={STROKE}
              stroke={color}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          )}
        </svg>
        <div className="gauge-center">
          {w ? (
            <>
              <span className="gauge-pct" style={{ color }}>
                {Math.round(w.used_percentage)}
                <span className="gauge-unit">%</span>
              </span>
              <span className="gauge-caption">{short} 使用済み</span>
            </>
          ) : (
            <span className="gauge-empty">—</span>
          )}
        </div>
      </div>

      <div className="gauge-info">
        <div className="gauge-head">
          <span className="gauge-label">{label}</span>
          <span className="gauge-hint">{hint}</span>
        </div>

        {w ? (
          <>
            {/* 時間の進み具合と、この調子で行った場合の着地を並べる */}
            <div className="bars">
              {elapsedPct != null && (
                <div className="bar-row">
                  <span className="bar-name">時間経過</span>
                  <span className="bar-track">
                    <span className="bar-fill neutral" style={{ width: `${elapsedPct}%` }} />
                  </span>
                  <span className="bar-num muted">{Math.round(elapsedPct)}%</span>
                </div>
              )}
              {projected != null && (
                <div className="bar-row">
                  <span className="bar-name">着地見込</span>
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      style={{
                        width: `${Math.min(projected, 100)}%`,
                        background: hueFor(projected),
                      }}
                    />
                  </span>
                  <span className="bar-num" style={{ color: hueFor(projected) }}>
                    {Math.round(projected)}%
                  </span>
                </div>
              )}
            </div>

            <div className="gauge-facts">
              <span className="fact">
                <ClockIcon />
                {clockOf(w.resets_at)} にリセット
                <span className="muted"> / あと {durationOf(w.resets_in_secs)}</span>
              </span>

              <span className={"verdict " + (w.exhausts_before_reset ? "warn" : "ok")}>
                <VerdictIcon warn={w.exhausts_before_reset} />
                {w.used_percentage >= 100
                  ? "上限に到達"
                  : projected == null
                    ? "見込みは未算出"
                    : w.exhausts_before_reset && w.projected_full_at != null
                      ? `${clockOf(w.projected_full_at)} に上限到達`
                      : elapsedPct != null && elapsedPct >= 98
                        ? "まもなくリセット"
                        : "リセットまで余裕あり"}
              </span>

              <span className="gauge-note">
                枠の開始からの平均ペースによる目安。まとめて使うと大きく変動
              </span>
            </div>
          </>
        ) : (
          <p className="gauge-none">データがありません</p>
        )}
      </div>
    </section>
  );
}

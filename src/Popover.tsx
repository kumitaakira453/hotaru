import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { RefreshIcon } from "./components/RefreshIcon";
import type { DetectResult, LimitWindow, RateLimits, WorkerList } from "./types";
import "./App.css";
import "./Popover.css";

const REFRESH_EVENT = "hotaru://refreshed";

// 本体の輪と同じ考え方。上限が目前のときだけ色を変える。
function hueFor(pct: number, tone: "day" | "week"): string {
  if (pct >= 85) return "var(--hot)";
  return tone === "week" ? "var(--calm-week)" : "var(--calm)";
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

function clockOf(epoch: number): string {
  const d = new Date(epoch * 1000);
  const now = new Date();
  const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hhmm;
  const wd = "日月火水木金土"[d.getDay()] ?? "";
  return `${d.getMonth() + 1}/${d.getDate()}(${wd}) ${hhmm}`;
}

function clockNow(): string {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ageOf(secs: number | null): string {
  if (secs === null) return "";
  if (secs < 60) return "たった今";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

/** 枠ひとつぶんの行。棒と数字だけで読めるようにする。 */
function LimitRow({
  name,
  tone,
  w,
}: {
  name: string;
  tone: "day" | "week";
  w: LimitWindow | null;
}) {
  if (!w) {
    return (
      <div className="pop-row">
        <div className="pop-row-head">
          <span className="pop-name">{name}</span>
          <span className="pop-none">データなし</span>
        </div>
      </div>
    );
  }
  const projected = w.projected_at_reset;
  // 本体の輪と同じ判定にする。使い切る見込みのときだけ警告色へ振る。
  const color =
    projected != null && projected >= 100 ? "var(--hot)" : hueFor(w.used_percentage, tone);
  return (
    <div className="pop-row">
      <div className="pop-row-head">
        <span className="pop-name">{name}</span>
        <span className="pop-pct" style={{ color }}>
          {Math.round(w.used_percentage)}%
        </span>
      </div>
      <div className="pop-track">
        {projected != null && (
          <span
            className="pop-fill projected"
            style={{ width: `${Math.min(projected, 100)}%`, background: color }}
          />
        )}
        <span
          className="pop-fill"
          style={{ width: `${Math.min(w.used_percentage, 100)}%`, background: color }}
        />
      </div>
      <div className="pop-sub">
        <span>
          {clockOf(w.resets_at)} リセット / あと {durationOf(w.resets_in_secs)}
        </span>
        {projected != null && (
          <span style={{ color }}>着地 {Math.round(projected)}%</span>
        )}
      </div>
    </div>
  );
}

export default function Popover() {
  const [limits, setLimits] = useState<RateLimits | null>(null);
  const [workers, setWorkers] = useState<WorkerList | null>(null);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rl, wk, dt] = await Promise.all([
        invoke<RateLimits>("read_rate_limits"),
        invoke<WorkerList>("list_workers"),
        invoke<DetectResult>("detect_stale_procs", {}),
      ]);
      setLimits(rl);
      setWorkers(wk);
      setDetected(dt);
      setCheckedAt(clockNow());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const un = listen(REFRESH_EVENT, () => void refresh());
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  // 開くたびに取り直す。しまっている間の変化をそのまま見せない。
  useEffect(() => {
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  const working = workers?.workers.filter((w) => w.alive && w.state === "working").length ?? 0;
  const blocked = workers?.workers.filter((w) => w.alive && w.state === "blocked").length ?? 0;
  const done = workers?.workers.filter((w) => w.alive && w.state === "done").length ?? 0;
  const stale = detected?.procs.length ?? 0;

  return (
    <div className="pop">
      <header className="pop-head">
        <span className="pop-title">
          <span className="mark" aria-hidden />
          hotaru
        </span>
        {checkedAt && <span className="pop-checked">最終確認 {checkedAt}</span>}
        <button className="pop-refresh" onClick={() => void refresh()} title="取り直す">
          <RefreshIcon size={12} />
        </button>
      </header>

      <section className="pop-section">
        <LimitRow name="5 時間枠" tone="day" w={limits?.five_hour ?? null} />
        <LimitRow name="7 日枠" tone="week" w={limits?.seven_day ?? null} />
        {/* 取りに行けたときは古さの話をしない。書き置きへ戻ったときだけ断る */}
        {limits?.available && limits.source === "cache" && (limits.age_secs ?? 0) > 300 && (
          <div
            className="pop-age"
            title="いま取りに行けなかったため、Claude Code の書き置きを表示しています"
          >
            Claude Code が {ageOf(limits.age_secs)}に記録した値です
          </div>
        )}
        {limits && limits.source === "cache" && !limits.statusline_wired && (
          <div className="pop-warn">statusline が未設定です</div>
        )}
      </section>

      <section className="pop-section">
        <div className="pop-section-title">セッション</div>
        <div className="pop-stats">
          <div>
            <span className="pop-stat-num" style={{ color: "var(--calm)" }}>
              {working}
            </span>
            <span className="pop-stat-name">作業中</span>
          </div>
          <div>
            <span className="pop-stat-num" style={{ color: "var(--accent)" }}>
              {blocked}
            </span>
            <span className="pop-stat-name">応答待ち</span>
          </div>
          <div>
            <span className="pop-stat-num" style={{ color: "var(--warm)" }}>
              {done}
            </span>
            <span className="pop-stat-name">完了</span>
          </div>
        </div>
        {workers && (
          <div className="pop-sub">
            <span>
              {workers.daemon_alive ? "daemon 稼働中" : "daemon 不在"} / 合計{" "}
              {workers.total_rss_mb}MB
            </span>
          </div>
        )}
      </section>

      <section className="pop-section">
        <div className="pop-section-title">片付け候補</div>
        <div className="pop-stale">
          <span className="pop-stat-num" style={{ color: stale > 0 ? "var(--hot)" : "var(--fg-faint)" }}>
            {stale}
          </span>
          <span className="pop-stat-name">
            {stale > 0 ? "件のプロセスが残っています" : "残っているものはありません"}
          </span>
        </div>
      </section>

      {error && <div className="pop-warn">{error}</div>}

      <footer className="pop-foot">
        <button className="pop-open" onClick={() => void invoke("open_main_window")}>
          詳しく見る
        </button>
      </footer>
    </div>
  );
}

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { Gauge } from "./components/Gauge";
import { UsageChart } from "./components/UsageChart";
import { WorkerPanel } from "./components/WorkerPanel";
import { DevProcPanel } from "./components/DevProcPanel";
import { updateCheckNonceAtom, updateStatusAtom } from "./state/updater";
import { RefreshIcon } from "./components/RefreshIcon";
import type {
  DetectResult,
  DevList,
  KillResult,
  RateLimits,
  StaleProc,
  UsageHistory,
  WorkerList,
} from "./types";
import "./App.css";

const REFRESH_EVENT = "hotaru://refreshed";
const THEME_KEY = "hotaru:theme";
const TAB_KEY = "hotaru:tab";
const SUBTAB_KEY = "hotaru:procTab";
const PERIOD_KEY = "hotaru:period";

type Theme = "light" | "dark";
type Tab = "usage" | "history" | "procs";
type ProcTab = "sessions" | "dev" | "stale";

const TABS: { key: Tab; label: string }[] = [
  { key: "usage", label: "使用状況" },
  { key: "history", label: "履歴" },
  { key: "procs", label: "プロセス" },
];

const PROC_TABS: { key: ProcTab; label: string }[] = [
  { key: "sessions", label: "セッション" },
  { key: "dev", label: "開発プロセス" },
  { key: "stale", label: "片付け候補" },
];

function formatAge(secs: number | null): string {
  if (secs === null) return "取得時刻が不明";
  if (secs < 60) return "たった今";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}日`;
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}

function SunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6" />
        <path d="M3.4 3.4 4.5 4.5M11.5 11.5l1.1 1.1M12.6 3.4 11.5 4.5M4.5 11.5l-1.1 1.1" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M13 9.6A5.8 5.8 0 0 1 6.4 3a5.9 5.9 0 1 0 6.6 6.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 更新の確認がどこまで進んだかを言葉にする。 */
function updateLabel(status: string): string {
  switch (status) {
    case "checking":
      return "確認中";
    case "available":
      return "新しい版があります";
    case "uptodate":
      return "最新です";
    case "error":
      return "確認できませんでした";
    default:
      return "";
  }
}

function clockNow(): string {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function App() {
  const [limits, setLimits] = useState<RateLimits | null>(null);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [devList, setDevList] = useState<DevList | null>(null);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [workers, setWorkers] = useState<WorkerList | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [vanishing, setVanishing] = useState<Set<number>>(new Set());
  // 停止を頼んでから結果が返るまでの間、どれを処理中か示す。
  const [stopping, setStopping] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.key === saved) ? (saved as Tab) : "usage";
  });
  const [procTab, setProcTab] = useState<ProcTab>(() => {
    const saved = localStorage.getItem(SUBTAB_KEY);
    return PROC_TABS.some((t) => t.key === saved) ? (saved as ProcTab) : "sessions";
  });
  const [period, setPeriod] = useState<number>(() => {
    const saved = localStorage.getItem(PERIOD_KEY);
    const n = saved === null ? NaN : Number(saved);
    return Number.isFinite(n) ? n : 14;
  });
  const [version, setVersion] = useState<string>("");
  const updateStatus = useAtomValue(updateStatusAtom);
  const bumpUpdateCheck = useSetAtom(updateCheckNonceAtom);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    // 初回だけ OS の設定に合わせ、以降は選んだものを覚える。
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion("不明"));
  }, []);

  useEffect(() => localStorage.setItem(TAB_KEY, tab), [tab]);
  useEffect(() => localStorage.setItem(SUBTAB_KEY, procTab), [procTab]);
  useEffect(() => localStorage.setItem(PERIOD_KEY, String(period)), [period]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rl, dt, hi, wk, dv] = await Promise.all([
        invoke<RateLimits>("read_rate_limits"),
        invoke<DetectResult>("detect_stale_procs", {}),
        invoke<UsageHistory>("read_usage_history", { days: period }),
        invoke<WorkerList>("list_workers"),
        invoke<DevList>("list_dev_procs", {}),
      ]);
      setLimits(rl);
      setDetected(dt);
      setHistory(hi);
      setWorkers(wk);
      setDevList(dv);
      // 確実な残骸は最初から選んでおき、判断が要るものは触れずに残す。
      setSelected(new Set(dt.procs.filter((p) => p.certain).map((p) => p.pid)));
      setCheckedAt(clockNow());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void refresh();
    const un = listen(REFRESH_EVENT, () => void refresh());
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  // 手元で完結する操作はキーボードからも届くようにする
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void refresh();
        return;
      }
      if (mod && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        setTab(TABS[Number(e.key) - 1].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);

  const toggle = (pid: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  /** 選ばれたプロセスを止め、結果を伝える。 */
  const kill = useCallback(
    async (pids: number[]) => {
      if (pids.length === 0) return;
      setBusy(true);
      setStopping(new Set(pids));
      setError(null);
      try {
        const result = await invoke<KillResult>("kill_stale_procs", { pids });
        setStopping(new Set());
        // 消えた行は光が引くように見せてから畳む。
        setVanishing(new Set(result.stopped));
        window.setTimeout(() => {
          setVanishing(new Set());
          void refresh();
        }, 420);
        const failed = result.failed.length;
        setNotice(
          failed === 0
            ? `${result.stopped.length} 件を回収しました`
            : `${result.stopped.length} 件を回収、${failed} 件は残りました`,
        );
        if (failed > 0) {
          setError(result.failed.map((f) => `PID ${f.pid}: ${f.reason}`).join("\n"));
        }
        window.setTimeout(() => setNotice(null), 3200);
      } catch (e) {
        setError(String(e));
        setStopping(new Set());
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const wire = async () => {
    setBusy(true);
    try {
      const msg = await invoke<string>("wire_statusline");
      setNotice(msg);
      setError(null);
      window.setTimeout(() => setNotice(null), 3200);
      void refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const procs = detected?.procs ?? [];
  const certainCount = procs.filter((p) => p.certain).length;

  return (
    <div className="app">
      {/* 信号機ボタンが浮かぶ帯を空け、その下から中身を始める */}
      <header className="head" data-tauri-drag-region>
        <div className="title" data-tauri-drag-region>
          <span className="mark" aria-hidden data-tauri-drag-region />
          hotaru
        </div>

        <div className="head-actions" data-tauri-drag-region>
          {/* 押すともう片方になる。出ているのは切り替え先の姿。 */}
          <button
            className="theme-btn"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "明るい配色にする" : "暗い配色にする"}
            aria-label={theme === "dark" ? "明るい配色にする" : "暗い配色にする"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>

          <button
            className="refresh"
            onClick={() => void refresh()}
            disabled={busy || loading}
            title="今すぐ取り直す（⌘R）"
            aria-label="今すぐ取り直す"
          >
            <RefreshIcon size={14} spinning={loading} />
          </button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
            title={`⌘${i + 1}`}
          >
            {t.label}
            {t.key === "procs" && procs.length > 0 && (
              <span className="tab-badge">{procs.length}</span>
            )}
          </button>
        ))}
        <span className="tabs-tail">{checkedAt ? `最終確認 ${checkedAt}` : ""}</span>
      </nav>

      <div className="scroll">
        {tab === "usage" && (
          <>
            {limits && !limits.statusline_wired && (
              <div className="callout">
                <p>使用状況は statusline から受け取ります。まだ設定されていません。</p>
                <button className="primary" onClick={() => void wire()} disabled={busy}>
                  statusline に設定する
                </button>
              </div>
            )}

            <Gauge
              label="5 時間"
              short="5h"
              hint=""
              tone="day"
              window={limits?.five_hour ?? null}
            />
            <Gauge
              label="7 日"
              short="7d"
              hint=""
              tone="week"
              window={limits?.seven_day ?? null}
            />

            {limits?.spend_limit && (
              <div className="spend">
                利用枠 {Math.round(limits.spend_limit.used_percentage)}% を使用
              </div>
            )}

            {/* 取り直した時刻は上に出ているので、値そのものが古いときだけ触れる */}
            {limits && !limits.available && (
              <div className="freshness">
                {limits.statusline_wired ? "セッションが動くと値が入ります" : "使用状況は未取得"}
              </div>
            )}
            {limits?.available && (limits.age_secs ?? 0) > 300 && (
              <div className="freshness stale-note">
                この値は {formatAge(limits.age_secs)}のものです
              </div>
            )}
          </>
        )}

        {tab === "history" && (
          <UsageChart
            history={history}
            period={period}
            onPeriodChange={setPeriod}
            loading={loading}
          />
        )}

        {tab === "procs" && (
          <>
            <nav className="subtabs section">
              {PROC_TABS.map((t) => (
                <button
                  key={t.key}
                  className={procTab === t.key ? "on" : ""}
                  onClick={() => setProcTab(t.key)}
                >
                  {t.label}
                  <span className="subtab-count">
                    {t.key === "sessions"
                      ? (workers?.workers.length ?? 0)
                      : t.key === "dev"
                        ? (devList?.procs.length ?? 0)
                        : procs.length}
                  </span>
                </button>
              ))}
            </nav>

            <section className="panel">
              {procTab === "sessions" && <WorkerPanel list={workers} />}

              {procTab === "dev" && (
                <DevProcPanel
                  list={devList}
                  busy={busy}
                  onKill={kill}
                  vanishing={vanishing}
                  stopping={stopping}
                />
              )}

              {procTab === "stale" && (
                <>
                  <div className="panel-head">
                    <h2 className="panel-title">
                      片付け候補
                      <span className="count">{procs.length}</span>
                    </h2>
                    {procs.length > 0 && (
                      <button
                        className="primary"
                        onClick={() => void kill([...selected])}
                        disabled={busy || selected.size === 0}
                      >
                        {stopping.size > 0 ? (
                          <>
                            <span className="btn-spinner" aria-hidden />
                            {stopping.size} 件を停止中
                          </>
                        ) : (
                          `${selected.size} 件を一掃`
                        )}
                      </button>
                    )}
                  </div>

                  {procs.length === 0 ? (
                    <p className="empty">
                      片付けるものはありません。
                      {detected
                        ? `稼働中のセッションが抱える ${detected.protected_count} プロセスは対象外です。`
                        : ""}
                    </p>
                  ) : (
                    <>
                      {certainCount > 0 && (
                        <p className="hint">
                          確実な残骸 {certainCount}{" "}
                          件を選択済み。他は内容を確かめてから選んでください。
                        </p>
                      )}
                      <ul className="list">
                        {procs.map((p: StaleProc) => (
                          <li
                            key={p.pid}
                            className={
                              "row" +
                              (p.certain ? " certain" : "") +
                              (stopping.has(p.pid) ? " stopping" : "") +
                              (vanishing.has(p.pid) ? " vanishing" : "")
                            }
                          >
                            <label>
                              {stopping.has(p.pid) ? (
                                <span className="row-spinner" aria-hidden />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={selected.has(p.pid)}
                                  onChange={() => toggle(p.pid)}
                                />
                              )}
                              <span className="row-main">
                                <span className="row-top">
                                  <span className="name">{p.name}</span>
                                  <span className="tag">{p.category}</span>
                                </span>
                                <span className="row-reason">{p.reason}</span>
                                <span className="row-meta">
                                  PID {p.pid} · 親 {p.ppid} · {formatUptime(p.uptime_secs)} ·{" "}
                                  {p.rss_mb}MB
                                </span>
                                <span className="row-cmd" title={p.cmd}>
                                  {p.cmd}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <pre className="error">{error}</pre>}

      <footer className="foot">
        <span className="foot-name">hotaru {version && `v${version}`}</span>
        {updateStatus !== "idle" && (
          <span className={"foot-status" + (updateStatus === "error" ? " warn" : "")}>
            {updateLabel(updateStatus)}
          </span>
        )}
        <button
          className="ghost"
          onClick={() => bumpUpdateCheck((n) => n + 1)}
          disabled={updateStatus === "checking"}
        >
          更新を確認
        </button>
      </footer>

      <UpdateBanner />
    </div>
  );
}

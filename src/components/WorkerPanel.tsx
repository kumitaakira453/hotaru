import { useState } from "react";
import type { Worker, WorkerList } from "../types";

type Bucket = "working" | "blocked" | "done" | "gone";
type Filter = "all" | Bucket;

function bucketOf(w: Worker): Bucket {
  if (!w.alive) return "gone";
  if (w.state === "working" || w.state === "starting") return "working";
  if (w.state === "blocked") return "blocked";
  return "done";
}

const CHIP: Record<Bucket, string> = {
  working: "作業中",
  blocked: "応答待ち",
  done: "完了",
  gone: "プロセスなし",
};

/** 状態そのものの言い回し。チップに出す。 */
function chipLabel(w: Worker): string {
  if (!w.alive) return CHIP.gone;
  if (w.state === "starting") return "起動中";
  return CHIP[bucketOf(w)];
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}日${h % 24}時間`;
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}

function sinceUpdate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return "たった今";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** 抱えているプロセスを種類ごとにまとめ、多い順に並べる。 */
function summarize(w: Worker): { kind: string; count: number; mb: number }[] {
  const by = new Map<string, { kind: string; count: number; mb: number }>();
  for (const c of w.children) {
    const e = by.get(c.kind) ?? { kind: c.kind, count: 0, mb: 0 };
    e.count += 1;
    e.mb += c.rss_mb;
    by.set(c.kind, e);
  }
  // 分類できなかったものは、大きさに関わらず末尾へ回す。
  return [...by.values()].sort((a, b) => {
    const rank = (k: string) => (k === "その他" ? 1 : 0);
    return rank(a.kind) - rank(b.kind) || b.mb - a.mb;
  });
}

type Props = {
  list: WorkerList | null;
};

export function WorkerPanel({ list }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!list) {
    return <p className="empty">読み込み中</p>;
  }

  const counts: Record<Filter, number> = {
    all: list.workers.length,
    working: list.workers.filter((w) => bucketOf(w) === "working").length,
    blocked: list.workers.filter((w) => bucketOf(w) === "blocked").length,
    done: list.workers.filter((w) => bucketOf(w) === "done").length,
    gone: list.workers.filter((w) => bucketOf(w) === "gone").length,
  };

  const shown =
    filter === "all" ? list.workers : list.workers.filter((w) => bucketOf(w) === filter);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 一覧のチップと同じ色をフィルタにも持たせて、対応が分かるようにする
  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "すべて" },
    { key: "working", label: "作業中" },
    { key: "blocked", label: "応答待ち" },
    { key: "done", label: "完了" },
    { key: "gone", label: "不在" },
  ];

  return (
    <>
      <div className="panel-head">
        <h2 className="panel-title">Claude のセッション</h2>
        <span className="panel-note">
          {list.daemon_alive ? `daemon 稼働中 ${list.daemon_rss_mb}MB` : "daemon 不在"} / 合計{" "}
          {list.total_rss_mb}MB
        </span>
      </div>

      <div className="subtabs toned">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tone-${t.key}` + (filter === t.key ? " on" : "")}
            onClick={() => setFilter(t.key)}
            disabled={counts[t.key] === 0 && t.key !== "all"}
          >
            {t.key !== "all" && <span className="tone-dot" aria-hidden />}
            {t.label}
            <span className="subtab-count">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {counts.blocked > 0 && filter !== "done" && (
        <p className="hint">
          応答待ちが {counts.blocked} 件あります。こちらの入力を待って止まっています。
        </p>
      )}
      {counts.done > 0 && filter !== "working" && filter !== "blocked" && (
        <p className="hint">
          完了したまま残っているセッションが {counts.done} 件。閉じると daemon
          ごと片付き、抱えているプロセスも解放されます。
        </p>
      )}

      {shown.length === 0 ? (
        <p className="empty">該当するセッションはありません</p>
      ) : (
        <ul className="worker-list">
          {shown.map((w) => {
            const open = expanded.has(w.job_id);
            const summary = summarize(w);
            const bucket = bucketOf(w);
            return (
              <li key={w.job_id} className={`worker ${bucket}`}>
                <div className="worker-body">
                  <div className="worker-top">
                    <span className="worker-name">
                      {w.name ?? w.intent?.slice(0, 34) ?? w.job_id}
                    </span>
                    <span className={`chip chip-${bucket}`}>
                      <span className="chip-dot" aria-hidden />
                      {chipLabel(w)}
                    </span>
                  </div>
                  {w.detail && <div className="worker-detail">{w.detail}</div>}
                  <div className="worker-meta">
                    {formatUptime(w.uptime_secs)} · {w.rss_mb}MB
                    {w.tokens ? ` · ${shortTokens(w.tokens)} トークン` : ""}
                    {w.updated_at ? ` · ${sinceUpdate(w.updated_at)}` : ""}
                  </div>

                  {summary.length > 0 && (
                    <>
                      <button className="worker-expand" onClick={() => toggle(w.job_id)}>
                        {open ? "内訳を隠す" : `抱えているプロセス ${w.children.length}`}
                        <span className="muted">
                          {summary
                            .slice(0, 3)
                            .map((s) => `${s.kind} ${s.count}`)
                            .join(" · ")}
                        </span>
                      </button>
                      {open && (
                        <ul className="child-list">
                          {w.children.map((c) => (
                            <li key={c.pid} className="child has-tip" data-tip={c.cmd}>
                              <span className="child-kind">{c.kind}</span>
                              <span className="child-name">{c.name}</span>
                              <span className="child-meta">
                                PID {c.pid} · {c.rss_mb}MB
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

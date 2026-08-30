import { useMemo, useState } from "react";
import type { DevList, DevProc } from "../types";

/** 誰が起動したものかで色を分ける。 */
const OWNER_TONE: Record<string, string> = {
  Claude: "claude",
  エディタ: "editor",
  その他: "other",
  親なし: "orphan",
};

type GroupBy = "none" | "kind" | "project" | "owner";

const GROUPS: { key: GroupBy; label: string }[] = [
  { key: "none", label: "なし" },
  { key: "kind", label: "種類" },
  { key: "project", label: "プロジェクト" },
  { key: "owner", label: "起動元" },
];

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={"chev" + (open ? " open" : "")}
      width="9"
      height="9"
      viewBox="0 0 12 12"
      aria-hidden
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 同じ顔ぶれをまとめた 1 行。 */
type Row = {
  key: string;
  sample: DevProc;
  items: DevProc[];
  mb: number;
  stale: number;
};

function shortUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}日`;
  if (h > 0) return `${h}時間`;
  return `${m}分`;
}

function keyOf(p: DevProc, by: GroupBy): string {
  if (by === "kind") return p.kind;
  if (by === "project") return p.project ?? "作業ディレクトリ外";
  if (by === "owner") return p.owner;
  return "";
}

/** 束ねている軸そのものは行に出さず、残りの手がかりを添える。 */
function sideNote(p: DevProc, by: GroupBy): string {
  const parts: string[] = [];
  if (by !== "kind") parts.push(p.kind);
  if (by !== "project" && p.project) parts.push(p.project);
  if (by !== "owner") parts.push(p.owner);
  return parts.join(" · ");
}

/** 名前も置き場所も同じものは、数をまとめて 1 行にする。 */
function bundle(items: DevProc[], by: GroupBy): Row[] {
  const map = new Map<string, DevProc[]>();
  for (const p of items) {
    const k = `${p.name}|${p.kind}|${p.project ?? ""}|${p.owner}`;
    const arr = map.get(k);
    if (arr) arr.push(p);
    else map.set(k, [p]);
  }
  return [...map.entries()]
    .map(([key, list]) => ({
      key,
      sample: list[0],
      items: list,
      mb: list.reduce((a, p) => a + p.rss_mb, 0),
      stale: list.filter((p) => p.stale).length,
    }))
    .sort((a, b) => b.mb - a.mb);
}

type Props = {
  list: DevList | null;
  busy: boolean;
  vanishing: Set<number>;
  onKill: (pids: number[]) => Promise<void>;
};

export function DevProcPanel({ list, busy, vanishing, onKill }: Props) {
  const [owner, setOwner] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const procs = list?.procs ?? [];
  const shown = owner === "all" ? procs : procs.filter((p) => p.owner === owner);

  // 同じ役目のものをまとめて、占めている量の大きい束から見せる。
  const groups = useMemo(() => {
    if (groupBy === "none") {
      return [
        { key: "", rows: bundle(shown, groupBy), mb: shown.reduce((a, p) => a + p.rss_mb, 0) },
      ];
    }
    const map = new Map<string, DevProc[]>();
    for (const p of shown) {
      const k = keyOf(p, groupBy);
      const arr = map.get(k);
      if (arr) arr.push(p);
      else map.set(k, [p]);
    }
    return [...map.entries()]
      .map(([key, items]) => ({
        key,
        rows: bundle(items, groupBy),
        mb: items.reduce((a, p) => a + p.rss_mb, 0),
      }))
      .sort((a, b) => b.mb - a.mb);
  }, [shown, groupBy]);

  if (!list) {
    return <p className="empty">読み込み中</p>;
  }

  const owners = ["Claude", "エディタ", "その他", "親なし"];
  const counts: Record<string, number> = { all: procs.length };
  for (const o of owners) {
    counts[o] = procs.filter((p) => p.owner === o).length;
  }

  const shownMb = shown.reduce((a, p) => a + p.rss_mb, 0);
  const stoppable = shown.filter((p) => p.stale);
  // 行の背に敷く帯は、まとめた後の一番大きいものを基準にする。
  const maxMb = Math.max(...groups.flatMap((g) => g.rows.map((r) => r.mb)), 1);

  const pick = (pids: number[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const pid of pids) {
        if (on) next.add(pid);
        else next.delete(pid);
      }
      return next;
    });

  const toggleSet = (setter: typeof setCollapsed) => (key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleGroup = toggleSet(setCollapsed);
  const toggleRow = toggleSet(setOpened);

  const sweep = async () => {
    await onKill([...picked]);
    setPicked(new Set());
  };

  const renderRow = (r: Row) => {
    const many = r.items.length > 1;
    const stalePids = r.items.filter((p) => p.stale).map((p) => p.pid);
    const allPicked = stalePids.length > 0 && stalePids.every((pid) => picked.has(pid));
    const isOpen = opened.has(r.key);
    const gone = r.items.every((p) => vanishing.has(p.pid));

    return (
      <li key={r.key} className={"dev-row" + (gone ? " vanishing" : "")}>
        <div
          className={"dev" + (r.stale > 0 ? " stale" : "")}
          style={{ ["--share" as string]: `${(r.mb / maxMb) * 100}%` }}
          title={r.sample.cmd}
        >
          {/* 稼働中のものは掴めないようにして、事故を起こしようがなくする */}
          {stalePids.length > 0 ? (
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() => pick(stalePids, !allPicked)}
              aria-label={`${r.sample.name} を選ぶ`}
            />
          ) : (
            <span className="dev-lock" title="稼働中のため停止できません" aria-hidden>
              <svg width="10" height="10" viewBox="0 0 16 16">
                <rect
                  x="3.2"
                  y="7"
                  width="9.6"
                  height="7"
                  rx="1.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <path
                  d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
              </svg>
            </span>
          )}

          <span className="dev-name">{r.sample.name}</span>
          {many && (
            <button
              className={"dev-count" + (isOpen ? " on" : "")}
              onClick={() => toggleRow(r.key)}
              title={isOpen ? "内訳を閉じる" : "内訳を開く"}
            >
              <Chevron open={isOpen} />
              {r.items.length}
            </button>
          )}
          <span className="dev-note">{sideNote(r.sample, groupBy)}</span>
          {!many && <span className="dev-time">{shortUptime(r.sample.uptime_secs)}</span>}
          <span className="dev-mb">{r.mb}MB</span>
        </div>

        {many && (
          <div className={"dev-children-wrap" + (isOpen ? " open" : "")}>
            <ul className="dev-children">
            {r.items.map((p) => (
              <li key={p.pid} className={vanishing.has(p.pid) ? "vanishing" : ""}>
                {p.stale ? (
                  <input
                    type="checkbox"
                    checked={picked.has(p.pid)}
                    onChange={() => pick([p.pid], !picked.has(p.pid))}
                    aria-label={`PID ${p.pid} を選ぶ`}
                  />
                ) : (
                  <span className="dev-lock-small" aria-hidden />
                )}
                <span className="dev-pid">PID {p.pid}</span>
                <span className="dev-note">親 {p.ppid}</span>
                <span className="dev-time">{shortUptime(p.uptime_secs)}</span>
                <span className="dev-mb">{p.rss_mb}MB</span>
              </li>
              ))}
            </ul>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <div className="panel-head">
        <h2 className="panel-title">動いている開発プロセス</h2>
        <span className="panel-note">合計 {list.total_rss_mb}MB</span>
      </div>

      <div className="subtabs toned">
        <button
          className={"tone-all" + (owner === "all" ? " on" : "")}
          onClick={() => setOwner("all")}
        >
          すべて
          <span className="subtab-count">{counts.all}</span>
        </button>
        {owners.map((o) => (
          <button
            key={o}
            className={`tone-${OWNER_TONE[o]}` + (owner === o ? " on" : "")}
            onClick={() => setOwner(o)}
            disabled={counts[o] === 0}
          >
            <span className="tone-dot" aria-hidden />
            {o}
            <span className="subtab-count">{counts[o]}</span>
          </button>
        ))}
      </div>

      <div className="groupby">
        <span className="groupby-label">内訳</span>
        {GROUPS.map((g) => (
          <button
            key={g.key}
            className={groupBy === g.key ? "on" : ""}
            onClick={() => setGroupBy(g.key)}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="dev-bar">
        <span className="hint">
          表示中 {shown.length} 件 / {shownMb}MB
          {stoppable.length > 0 ? ` · 止めてよいもの ${stoppable.length}` : ""}
        </span>
        {picked.size > 0 && (
          <button className="primary" onClick={() => void sweep()} disabled={busy}>
            {picked.size} 件を停止
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="empty">該当するプロセスはありません</p>
      ) : groupBy === "none" ? (
        <ul className="dev-list">{groups[0].rows.map(renderRow)}</ul>
      ) : (
        <div className="group-list">
          {groups.map((g) => {
            const open = !collapsed.has(g.key);
            const staleCount = g.rows.reduce((a, r) => a + r.stale, 0);
            const total = g.rows.reduce((a, r) => a + r.items.length, 0);
            return (
              <section key={g.key} className="group">
                <button className="group-head" onClick={() => toggleGroup(g.key)}>
                  <Chevron open={open} />
                  <span className="group-name">{g.key}</span>
                  <span className="group-meta">
                    {total} 件 · {g.mb}MB
                    {staleCount > 0 && <span className="group-stale"> 片付け {staleCount}</span>}
                  </span>
                </button>
                {open && <ul className="dev-list">{g.rows.map(renderRow)}</ul>}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

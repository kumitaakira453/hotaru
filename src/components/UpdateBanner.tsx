import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { updateCheckNonceAtom, updateStatusAtom } from "../state/updater";

type Phase = "hidden" | "available" | "downloading" | "error";

// 起動時に最新版を確認し、更新があれば右下に通知を出す。
// 「更新して再起動」でダウンロード＋インストールから再起動まで行う。
export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [update, setUpdate] = useState<Update | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 起動時と、メニューの「更新を確認」（nonce をインクリメント）で走る
  const nonce = useAtomValue(updateCheckNonceAtom);
  const setStatus = useSetAtom(updateStatusAtom);

  useEffect(() => {
    // Tauri 以外（dev のブラウザ等）では静かに無効化する
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    void (async () => {
      setStatus("checking");
      try {
        const u = await check();
        if (cancelled) return;
        if (u) {
          setUpdate(u);
          setPhase("available");
          setStatus("available");
        } else {
          setStatus("uptodate");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, setStatus]);

  const runUpdate = async () => {
    if (!update) return;
    setPhase("downloading");
    setError(null);
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
        } else if (e.event === "Progress") {
          downloaded += e.data.chunkLength;
          setPct(total > 0 ? Math.round((downloaded / total) * 100) : 0);
        }
      });
      await relaunch();
    } catch (err) {
      setError(String(err));
      setPhase("error");
    }
  };

  if (phase === "hidden" || !update) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[320px] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-2xl">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
          <span aria-hidden>🚀</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[var(--app-fg)]">
            新しいバージョン {update.version} が利用できます
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--app-muted)]">
            現在 v{update.currentVersion}
          </div>
          {update.body && phase === "available" && (
            <p className="mt-2 line-clamp-3 whitespace-pre-line text-[11px] leading-relaxed text-[var(--app-fg-dim)]">
              {update.body}
            </p>
          )}
          {phase === "error" && (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--app-danger)]">
              更新に失敗しました: {error}
            </p>
          )}

          {phase === "downloading" ? (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-hover)]">
                <div
                  className="h-full bg-[var(--app-accent)] transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1.5 text-[11px] text-[var(--app-muted)]">
                ダウンロード中… {pct}%
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={runUpdate}
                className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition hover:opacity-90"
              >
                {phase === "error" ? "再試行" : "更新して再起動"}
              </button>
              <button
                type="button"
                onClick={() => setPhase("hidden")}
                className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
              >
                後で
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

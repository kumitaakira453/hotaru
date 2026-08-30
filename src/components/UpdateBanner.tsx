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
  // 起動時と、フッターの「更新を確認」（nonce をインクリメント）で走る
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
    <div className="update-card">
      <div className="update-body">
        <div className="update-title">新しい版 {update.version} があります</div>
        <div className="update-current">現在 v{update.currentVersion}</div>

        {update.body && phase === "available" && <p className="update-note">{update.body}</p>}
        {phase === "error" && <p className="update-error">更新に失敗しました: {error}</p>}

        {phase === "downloading" ? (
          <div className="update-progress">
            <span className="update-track">
              <span className="update-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="update-pct">受け取り中 {pct}%</span>
          </div>
        ) : (
          <div className="update-actions">
            <button className="primary" onClick={() => void runUpdate()}>
              {phase === "error" ? "もう一度" : "更新して再起動"}
            </button>
            <button className="ghost" onClick={() => setPhase("hidden")}>
              後で
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

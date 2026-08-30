import { atom } from "jotai";

// 「更新を確認」を押すたびにインクリメントして再チェックを促す信号。
export const updateCheckNonceAtom = atom(0);

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "uptodate"
  | "error";

// 設定メニュー側で結果を出すために共有する。
export const updateStatusAtom = atom<UpdateStatus>("idle");

/**
 * 取り直しの印。時計回りの弧と、その終わりに続く矢じりで作る。
 *
 * 弧は中心 (8,8) 半径 5.2 を、右側に 60 度の切れ目を残して 300 度ぶん描く。
 * 矢じりは弧の終端 (55 度の位置) の接線方向に置いているので、線を書き足した
 * かたちの折れ線ではなく、弧とつながった三角形になる。
 */
export function RefreshIcon({ size = 13, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg
      className={spinning ? "spin" : ""}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
    >
      <path
        d="M13.18 8.45A5.2 5.2 0 1 1 10.98 3.74"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M13.44 5.46 9.57 5.07 11.74 1.95Z" fill="currentColor" />
    </svg>
  );
}

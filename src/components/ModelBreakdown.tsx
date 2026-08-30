import type { ModelUse } from "../types";

/** 並び順に当てる色。警告に使う色は避け、識別のためだけに使う。 */
const TONES = ["--chart", "--calm-week", "--calm", "--accent"];
/** これより多いモデルは「その他」にまとめる。 */
const SHOWN = 4;

function shortTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function percentText(share: number): string {
  if (share > 0 && share < 1) return "<1%";
  return `${Math.round(share)}%`;
}

type Row = {
  key: string;
  label: string;
  tokens: number;
  tip: string;
};

function rowsOf(models: ModelUse[]): Row[] {
  const detail = (m: ModelUse) =>
    `入力 ${m.input.toLocaleString()} / 出力 ${m.output.toLocaleString()} / ` +
    `キャッシュ読み ${m.cache_read.toLocaleString()} / キャッシュ書き ${m.cache_write.toLocaleString()}`;

  const head = models.slice(0, SHOWN).map((m) => ({
    key: m.model,
    label: m.label,
    tokens: m.tokens,
    tip: detail(m),
  }));

  const rest = models.slice(SHOWN);
  if (rest.length === 0) return head;
  return [
    ...head,
    {
      key: "rest",
      label: "その他",
      tokens: rest.reduce((a, m) => a + m.tokens, 0),
      tip: rest.map((m) => `${m.label} ${shortTokens(m.tokens)}`).join(" / "),
    },
  ];
}

/**
 * いま使っている 5 時間枠の中で、どのモデルをどれだけ通したか。
 *
 * 枠の使用率は全体の値しか届かないため、内訳は手元の会話ログから数えている。
 * 割合は 1 本の帯で見せ、数字は凡例に回して行の繰り返しを減らしている。
 */
export function ModelBreakdown({ models }: { models: ModelUse[] | null }) {
  if (!models || models.length === 0) return null;

  const total = models.reduce((a, m) => a + m.tokens, 0);
  if (total === 0) return null;

  const rows = rowsOf(models);
  const replies = models.reduce((a, m) => a + m.messages, 0);

  return (
    <section className="models">
      <div className="models-head">
        <span className="models-title">この枠で使ったモデル</span>
        <span className="models-total">計 {shortTokens(total)}</span>
      </div>

      <div className="models-bar">
        {rows.map((r, i) => (
          <span
            key={r.key}
            className="models-seg"
            style={{
              width: `${(r.tokens / total) * 100}%`,
              background: `var(${TONES[i % TONES.length]})`,
            }}
          />
        ))}
      </div>

      <ul className="models-legend">
        {rows.map((r, i) => (
          <li key={r.key} className="model-row has-tip" data-tip={r.tip}>
            <span
              className="model-dot"
              style={{ background: `var(${TONES[i % TONES.length]})` }}
              aria-hidden
            />
            <span className="model-name">{r.label}</span>
            <span className="model-share">{percentText((r.tokens / total) * 100)}</span>
            <span className="model-tokens">{shortTokens(r.tokens)}</span>
          </li>
        ))}
      </ul>

      <div className="models-note">会話ログから集計 / 応答 {replies.toLocaleString()} 件</div>
    </section>
  );
}

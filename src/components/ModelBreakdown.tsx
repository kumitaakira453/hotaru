import type { ModelUse } from "../types";

function shortTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * いま使っている 5 時間枠の中で、どのモデルをどれだけ通したか。
 *
 * 枠の使用率は全体の値しか届かないため、内訳は手元の会話ログから数えている。
 */
export function ModelBreakdown({ models }: { models: ModelUse[] | null }) {
  if (!models || models.length === 0) return null;

  const total = models.reduce((a, m) => a + m.tokens, 0);
  if (total === 0) return null;

  return (
    <section className="models">
      <div className="models-head">
        <span className="models-title">この枠で使ったモデル</span>
        <span className="models-total">{shortTokens(total)}</span>
      </div>
      {models.map((m) => {
        const share = (m.tokens / total) * 100;
        return (
          <div
            key={m.model}
            className="model-row has-tip"
            data-tip={`入力 ${m.input.toLocaleString()} / 出力 ${m.output.toLocaleString()} / キャッシュ読み ${m.cache_read.toLocaleString()} / キャッシュ書き ${m.cache_write.toLocaleString()}`}
          >
            <span className="model-name">{m.label}</span>
            <span className="model-track">
              <span className="model-fill" style={{ width: `${share}%` }} />
            </span>
            <span className="model-share">{Math.round(share)}%</span>
            <span className="model-tokens">{shortTokens(m.tokens)}</span>
          </div>
        );
      })}
      <div className="models-note">
        応答 {models.reduce((a, m) => a + m.messages, 0).toLocaleString()} 件ぶん。手元の会話ログから集計
      </div>
    </section>
  );
}

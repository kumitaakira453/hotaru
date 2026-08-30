# リリース手順

`v*` タグの push で GitHub Actions がビルドし、GitHub Releases に成果物と
自動更新用マニフェスト（`latest.json`）を添付する。既存インストールは起動時に
更新通知を受け取る。

## TL;DR

```bash
# 1) バージョンを上げる（下記 2 ファイルを同じ値に）
#    package.json / src-tauri/tauri.conf.json
#    src-tauri/Cargo.toml の version は上げない（固定）
npm install --package-lock-only
git checkout src-tauri/Cargo.lock      # ローカルビルドで動いた場合に戻す
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
# 2) Actions がビルドしてドラフト Release を作る
# 3) 内容を確認して Publish（公開）する
```

## バージョンの持ち方

| ファイル | フィールド | 備考 |
|----------|-----------|------|
| `package.json` | `version` | 表示・整合用 |
| `src-tauri/tauri.conf.json` | `version` | **リリース版の正**（updater / バンドル） |
| `src-tauri/Cargo.toml` | `[package] version` | **上げない（固定）** |

Cargo.toml の version を据え置くと Cargo.lock が安定し、CI の Rust キャッシュ
（Cargo.lock のハッシュがキー）が毎回ヒットしてビルドが速い。Tauri は
tauri.conf.json の version を優先するので実害はない。

自動更新が「更新あり」と判定するのはインストール済みより新しいバージョンの
ときだけなので、上記 2 ファイルは必ず上げる。

## 成果物

ドラフト Release に以下が揃っていれば配信できる。

- `hotaru_X.Y.Z_aarch64.dmg` — 手動インストール用
- `hotaru_aarch64.app.tar.gz` — 自動更新の本体
- `hotaru_aarch64.app.tar.gz.sig` — 署名
- `latest.json` — 更新マニフェスト

## タグ push で CI が起動しないとき

タグ push のイベント配信が数分遅れることがある。数分待って現れなければ
Actions → Release → *Run workflow* でタグ名を入力して手動起動する
（`workflow_dispatch` に対応済み）。手動起動はチェックアウト先がブランチに
なるため、タグとブランチ HEAD が同一であることを確認してから使う。

## 署名鍵

updater の成果物には署名が必要。鍵がまだ無い場合:

```bash
npx tauri signer generate -w ~/.tauri/hotaru.key
```

- 公開鍵 → `src-tauri/tauri.conf.json` の `plugins.updater.pubkey`
- 秘密鍵 → リポジトリの Secrets `TAURI_SIGNING_PRIVATE_KEY`
- パスワード → Secrets `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

秘密鍵はコミットしない。

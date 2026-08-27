# Health Web App

個人向けの健康・食事・習慣管理PWA。仕様の唯一の正は `要件定義書.md`（実装仕様書）、
開発体制・分担・品質ゲートのルールは `Health_Web_App_マルチエージェント開発要件定義書.md` に従う。

## 現在の状態

Phase 1（DBスキーマ基盤）まで完了。`users` / `user_profiles` と共通パターン（RLS・版番号・
冪等性・複合外部キー・Storage）のみで、機能テーブルと機能実装は未着手。

## 前提

- Node.js 24.x / npm 11.x（実装仕様書 2章）

## セットアップ

```bash
npm ci
cp .env.example .env.local   # 実値はGit管理外に置く
npm run dev
```

## 品質ゲート（実装仕様書 12章）

| コマンド            | 内容                                                    |
| ------------------- | ------------------------------------------------------- |
| `npm run typecheck` | TypeScript strict                                       |
| `npm run lint`      | ESLint                                                  |
| `npm run format`    | Prettier（チェックのみ。整形は `npm run format:write`） |
| `npm test`          | Vitest                                                  |
| `npm run build`     | 本番ビルド（`next build --webpack`）                    |
| `npm run env:check` | 環境変数検証（Phase 0 では雛形）                        |

## ディレクトリ構成

実装仕様書 2.1節に準拠する。サーバー専用モジュールは `import "server-only";` を宣言し、
Vitest では `src/tests/server-only.ts` のスタブへ差し替えてクライアント混入を禁止する。

## データベース

`supabase/migrations/` の SQL migration が正。機能テーブルを追加するときの列パターン・
複合外部キー・楽観ロック・RLS・Storage の規約は
[`docs/database/table-conventions.md`](docs/database/table-conventions.md) を参照する。
migration の検証は `npm test`（PGlite、Docker不要）で行う。Docker / Supabase CLI が無い環境で
検証できず後続フェーズへ送った項目は [`docs/known-issues.md`](docs/known-issues.md) に記録する。

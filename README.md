# Health Web App

個人向けの健康・食事・習慣管理PWA。仕様の唯一の正は `要件定義書.md`（実装仕様書）、
開発体制・分担・品質ゲートのルールは `Health_Web_App_マルチエージェント開発要件定義書.md` に従う。

## 現在の状態

Phase 2（認証・アカウント基盤）まで完了。Supabaseクライアント構成、認証画面（`/auth` 系）、
保護ルートのプロキシ、API共通境界、デモモード骨格、データ出力・削除の骨格までを実装した。
測定・運動・食事などの機能テーブルと機能画面は Phase 3 以降で着手する。

| フェーズ | 範囲                                                              |
| -------- | ----------------------------------------------------------------- |
| Phase 0  | プロジェクト初期化・共通基盤                                      |
| Phase 1  | DBスキーマ基盤（`users` / `user_profiles`、RLS基盤、Storage基盤） |
| Phase 2  | 認証・アカウント基盤（実装仕様書 3章・5.1節・7章・9章）           |

## 認証・アカウント基盤（Phase 2、実装仕様書 5.1節）

| 画面・API                                                    | 役割                                                |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `/auth`                                                      | メール+パスワード、サインアップ、Magic Link、Google |
| `/auth/forgot-password` / `/auth/update-password`            | パスワード再設定要求と新しいパスワードの設定        |
| `/auth/session`                                              | ログイン後の着地点。セッション確認とログアウト      |
| `/auth/callback` / `/auth/confirm`                           | OAuth・Magic Link のコード交換、メール確認          |
| `/demo`                                                      | 資格情報不要のデモモード骨格（IndexedDB のみ）      |
| `/api/account` / `/api/account/data` / `/api/account/export` | アカウント削除・健康データ削除・データ出力の骨格    |

- 保護ルートは `src/proxy.ts` → `src/lib/supabase/proxy.ts` の `protectedRoutePrefixes` で
  判定し、未認証は `/auth?next=...` へ丸める（実装仕様書 3.3節）。
- ログイン後の遷移先 `next` は `src/features/auth/redirect.ts` の `sanitizeNextPath` を
  必ず通す。外部オリジン・`//`・バックスラッシュ・NUL は `/auth/session` へ丸める
  （実装仕様書 5.1節、オープンリダイレクト対策）。
- 状態変更APIの共通境界（same-origin検証、`Content-Type: application/json`、
  リクエストボディ64KiB上限、`Cache-Control: no-store`、`{ error: { code, message } }`）は
  `src/server/api/` に集約する（実装仕様書 7章）。
- 所有者は常に `requireActiveUser()` が検証済みセッションから導出し、リクエストボディの
  `owner_id` / `user_id` は使わない。Supabase未設定は 503、`users.status` が active 以外は
  403 を返す（実装仕様書 3.2節・3.3節・5.1節）。

## 前提

- Node.js 26.x / npm 11.x（実装仕様書 2章）

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

## API 契約

機能ごとのリクエスト／レスポンス仕様は `docs/api/` に置く。

| 機能              | 契約                                                   | 型・スキーマの正本                         |
| ----------------- | ------------------------------------------------------ | ------------------------------------------ |
| 身体測定（5.3節） | [`docs/api/measurements.md`](docs/api/measurements.md) | `src/features/body-measurements/schema.ts` |

全 Route Handler に共通の境界（same-origin 検証、`Content-Type` 要求、64KiB 上限、
`no-store`、`{ error: { code, message } }` 形式）は `src/server/api/` にある。

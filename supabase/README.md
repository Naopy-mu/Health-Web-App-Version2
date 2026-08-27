# supabase

ローカル Supabase（Supabase CLI）の構成と SQL migration を置く（実装仕様書 6章・12章）。

| パス              | 内容                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `config.toml`     | ローカル Supabase の最小構成（API / DB / Auth / Storage / Studio） |
| `migrations/`     | SQL migration。ファイル名は `YYYYMMDDHHMMSS_<snake_case>.sql`      |
| `tests/database/` | pgTAP によるスキーマ契約・RLS分離テスト                            |

## migration 一覧（Phase 1: DBスキーマ基盤）

| ファイル                                     | 内容                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `20260827000100_owned_table_conventions.sql` | 版番号・冪等性の共通トリガーと取り付け関数（6.4節）                                        |
| `20260827000200_identity_core.sql`           | `users` / `user_profiles` / `is_active_user()` / `on_auth_user_created`（6.1・6.2・6.5節） |
| `20260827000300_identity_rls.sql`            | ID・プロフィールの RLS（6.5節・9章）                                                       |
| `20260827000400_storage_buckets.sql`         | 非公開バケットと Storage ポリシー（6.6節）                                                 |

機能テーブル（身体測定・運動・食事など）は後続フェーズで追加する。追加時の列パターン・
複合外部キー・楽観ロック・RLS のテンプレートは
[`docs/database/table-conventions.md`](../docs/database/table-conventions.md) を参照する。

## 検証

```bash
# Docker 不要。migration を PGlite へ新規適用して RLS・トリガーまで検証する
npm test

# Docker + Supabase CLI がある環境
supabase start
supabase db reset
supabase db lint
supabase test db
```

# tests

DB（PGliteによるmigration検証・スキーマ契約）、設定検証、ステージング検証の
Vitestテストを置く（実装仕様書 12章）。

| パス                           | 内容                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `db/pglite.ts`                 | PGlite へ migration を適用するテストヘルパー（テスト本体ではない）            |
| `db/supabase-shim.sql`         | PGlite 上で Supabase 相当の前提を再現するテスト専用 SQL（migration ではない） |
| `db/migrations.test.ts`        | migration の命名規則と新規適用、スキーマ契約                                  |
| `db/identity-rls.test.ts`      | `users` / `user_profiles` の所有者分離、`is_active_user()`、匿名拒否          |
| `db/mutation-patterns.test.ts` | `row_version` / 冪等性 / 楽観ロック / 複合外部キーのテンプレート              |
| `db/storage-policies.test.ts`  | 非公開バケット・パス規則・`owner_id` 検査（6.6節・5.8節）                     |

Docker は不要。Docker と Supabase CLI がある環境では `supabase test db`（pgTAP、
`supabase/tests/database/`）で同等の検証を実行できる。

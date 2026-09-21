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
| `db/postgres-docker.ts`        | Docker 上の実 PostgreSQL へ `psql` で繋ぐヘルパー（テスト本体ではない）       |
| `db/*.pg.test.ts`              | 実 PostgreSQL で2本のセッションを競合させる同時実行テスト（下記）             |

Docker は不要。Docker と Supabase CLI がある環境では `supabase test db`（pgTAP、
`supabase/tests/database/`）で同等の検証を実行できる。

## 実 PostgreSQL での同時実行テスト（`*.pg.test.ts`）

PGlite は接続が1本なので、2つのトランザクションを本当に並行させられない
（ロック待ちや、相手の未コミット行が見えないことを再現できない）。同時実行の
不変条件は、Docker 上の実 PostgreSQL へ `docker exec` で `psql` を2本常駐させ、
独立したセッションとして競合させて確かめる（DB ドライバは依存に足さない）。

環境変数 `RACE_PG_CONTAINER` が未設定なら、これらのテストは**飛ばされる**
（`npm test` は Docker 無しでも通る）。CI（`.github/workflows/ci.yml`）では
使い捨てのコンテナを立てて必ず実行する。手元では:

```sh
# シムが作るロール（anon など）はクラスタ全体の共有物なので、
# 開発用の Supabase ではなく**このテスト専用の使い捨てコンテナ**を使う。
docker run -d --name hwa-race-pg -e POSTGRES_PASSWORD=race postgres:17-alpine
RACE_PG_CONTAINER=hwa-race-pg npx vitest run tests/db/supplements-unit-race.pg.test.ts
docker rm -f hwa-race-pg
```

テストは毎回データベースを作り直し、`db/supabase-shim.sql` と全 migration を適用する。

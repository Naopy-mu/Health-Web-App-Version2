# src/lib/supabase

ブラウザ／サーバー／プロキシ用の Supabase クライアントと設定を置く（実装仕様書 2.1節）。

| ファイル    | 実行場所                                  | 用途                                                                            |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `config.ts` | 共通                                      | 公開設定（URL / publishable key）の読み出し、Supabase設定有無・デモモードの判定 |
| `client.ts` | ブラウザ                                  | `createBrowserClient`。RLS適用済みの所有者スコープ                              |
| `server.ts` | Server Component / Route Handler / Action | `createServerClient` + `next/headers` の Cookie                                 |
| `admin.ts`  | サーバー専用                              | `SUPABASE_SECRET_KEY` を使う service_role クライアント                          |
| `proxy.ts`  | プロキシ（`src/proxy.ts`）                | セッション更新と `protectedRoutePrefixes` による保護ルート判定                  |

## 秘密値の境界（実装仕様書 9.2節）

- `admin.ts` は `import "server-only"` を宣言し、クライアントバンドルへ混入した時点で
  ビルドが失敗する。`SUPABASE_SECRET_KEY` に `NEXT_PUBLIC_` を付けないこと。
- `config.ts` が読むのは `NEXT_PUBLIC_` 付きの公開可能な設定のみ。ここへ秘密値を
  持ち込まない。
- 通常の所有者スコープの読み書きには `server.ts` を使う。`admin.ts` は RLS を迂回する
  必要がある操作（利用者状態の遷移、Auth Admin API、破壊的な削除RPC）に限る。

## 未設定時のふるまい（実装仕様書 3.3節）

`config.ts` の `getSupabaseClientConfig()` は未設定時に `null` を返し、
`client.ts` / `server.ts` / `admin.ts` もそれぞれ `null` を返す。呼び出し側は
アカウントAPIなら HTTP 503（`ACCOUNT_SERVICE_UNAVAILABLE`）を返し、UIはデモモードへの
導線を示す。

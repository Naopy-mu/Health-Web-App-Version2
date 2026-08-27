# 既知の課題・バックログ

実装仕様書（`要件定義書.md`）の要求は満たしているが、**現在の開発環境では検証手段が
揃わない**ために後続フェーズへ送った項目を記録する。マルチエージェント開発要件定義書
5.4節（バグ修正の進め方）・7章（品質ゲート）に基づき、着手時は担当表と該当節を確認する。

## Phase 1（DBスキーマ基盤）バックログ

いずれも Docker / Supabase CLI が無い現在の環境では実行・検証できないため、Phase 1 では
コードを追加せず記録のみとした。**Supabase CLI / Docker 導入後の後続フェーズで対応する。**

| #    | 項目                                            | 内容                                                                                                                                                                                                                                                                                                                | 前提                                                                                                   | 該当節                        |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| P1-1 | pgTAP による実 Supabase 相当の Storage 検証拡充 | `supabase/tests/database/` に Storage ポリシーの pgTAP テストを追加する。最低限、(a) 匿名（`anon`）からの全操作拒否、(b) 他利用者による UPDATE 拒否、(c) パスは正しいが `storage.objects.owner_id` が一致しないケースの拒否、(d) `food-images-private` の HEIC/HEIF 拒否 を含める                                   | Docker + Supabase CLI（`supabase start` / `supabase test db`）                                         | 実装仕様書 6.6節・5.8節・12章 |
| P1-2 | `service_role` 分離テストの実効検証化           | `tests/db/identity-rls.test.ts` の「ブラウザの公開キーが名乗るロールは `service_role` の権限を持たない」は `pg_has_role(..., 'usage')` によるロールメンバーシップ検査にとどまる。`SET ROLE` で実際に `anon` / `authenticated` を名乗り、`private.*` や削除系 RPC へ到達できないことを実効的に確認する形へ切り替える | 実 Supabase 相当のロール構成（`supabase start`）。PGlite のシムでは `private.*` 実体と権限構成が未整備 | 実装仕様書 6.5節・9.2節       |

### 補足: PGlite シムで検出できない事象

`tests/db/supabase-shim.sql` は PGlite 上に Supabase の前提を再現するテスト専用ファイルで、
**migration 実行者がテーブル所有者になる**という点が実環境と根本的に異なる。そのため
以下は PGlite では再現できない。シムを実環境へ寄せることで検出漏れを減らすが、最終確認は
実 Supabase 相当環境（P1-1 / P1-2）で行う。

- テーブル所有者権限に依存する DDL の失敗（例: `storage.objects` への `ALTER TABLE` が
  42501 になる。所有者は `supabase_storage_admin`）
- 所有者接続が RLS を迂回すること（`FORCE ROW LEVEL SECURITY` を付けない限り所有者には
  ポリシーが適用されない）に起因する見かけ上の成功

## Phase 2（認証・アカウント基盤）バックログ

Phase 2 のスコープは「認証・アカウント基盤」であり、以下は**対象となるデータ・機能が
まだ存在しない**ため骨格までとした。該当ファイルには `TODO(Phase 3以降)` を記載してある。

| #    | 項目                                                | 現状                                                                                                                                                                    | 着手の前提                                                               | 該当節                       |
| ---- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| P2-1 | 健康データ削除の本実装                              | `DELETE /api/account/data` は same-origin・Content-Type・64KiB・認証・利用者状態・再認証まで検査し、本体は 501 を返す                                                   | 機能テーブルと削除RPC（`service_role` 限定）                             | 実装仕様書 5.1節・9.2節      |
| P2-2 | アカウント削除の本実装                              | `DELETE /api/account` も同様に 501。Google接続revoke → Storage削除 → Auth Admin API による削除 → CASCADE → セッション破棄の順序は未実装                                 | 機能テーブル・Google連携・Storage実体                                    | 実装仕様書 5.1節・5.11節     |
| P2-3 | データ出力の対象拡大とページング                    | `GET /api/account/export` の対象は `users` / `user_profiles` のみ。1テーブル25,000行・合計100,000行・ページサイズ500行の上限は定数のみ用意した                          | 機能テーブル                                                             | 実装仕様書 5.1節             |
| P2-4 | プロフィール編集UIの本実装                          | `/demo` は候補提示・確認保存・JSON出力・ブラウザ内削除の骨格。`ProfileWorkspace` と 5.2節の検証は未実装                                                                 | 実装仕様書 5.2節の着手（`/onboarding` と共通化）                         | 実装仕様書 3.1節・5.2節      |
| P2-5 | 認証フローのE2E（メールリンクの実地確認）           | 保護ルートのリダイレクト・利用者状態による締め出し・`next` の丸め・メールリンクの着地先は Vitest で検証済み。**実ブラウザでリンクを踏む往復は未検証**（下記 P2-5 詳細） | Docker + Supabase CLI（`supabase start` / Inbucket）、Playwright実行環境 | 実装仕様書 4章・5.1節・12章  |
| P2-6 | `env:check` の実装と `NEXT_PUBLIC_APP_URL` の必須化 | Phase 0 の雛形のまま。`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_APP_URL` の欠落検出は未実装（下記 P2-6 詳細）                  | 実装仕様書 13.1節の全変数の要否確定                                      | 実装仕様書 12章・13.1節・7章 |

### P2-5 詳細: メールテンプレート設定と実ブラウザ検証

実装仕様書 4章の画面表は、メール系フローの着地先を次のように分けている。

| ルート           | 役割                            | 検証方式                                       |
| ---------------- | ------------------------------- | ---------------------------------------------- |
| `/auth/callback` | OAuth / Magic Link のコード交換 | PKCE の `?code=` を `exchangeCodeForSession()` |
| `/auth/confirm`  | メール確認                      | `?token_hash=` + `?type=` を `verifyOtp()`     |

検証方式が違うため、**メールテンプレートも作り分ける必要がある**。

#### 設定済みの内容（このリポジトリ）

- `supabase/config.toml` の `[auth.email.template.*]` で 4 種のテンプレートを指定した。
- `supabase/templates/confirmation.html`（`type=signup`）、`recovery.html`（`type=recovery`）、
  `email_change.html`（`type=email_change`）は `{{ .TokenHash }}` 形式のリンクを組み立てる。
  既定の `{{ .ConfirmationURL }}` は `?code=` を返すため、`/auth/confirm` では使えない。
- `supabase/templates/magic_link.html` は **既定の `{{ .ConfirmationURL }}` のまま**。
  Supabase の `/auth/v1/verify` を経由して `/auth/callback?next=...&code=...` へ戻る。
- `confirmation.html` / `recovery.html` は `{{ .RedirectTo }}&token_hash=...&type=...` と連結する。
  `{{ .RedirectTo }}` は Server Action が渡す `emailRedirectTo` で、
  `src/features/auth/actions.ts` の `buildCallbackUrl()` が**必ず `?next=` を付ける**。
  この不変条件が崩れると連結が壊れるため、`buildCallbackUrl()` から `next` の付与を外さないこと
  （回帰テスト: `src/features/auth/actions.test.ts`「メールリンクの着地先URLには必ず `next` が付く」）。
- `additional_redirect_urls` にクエリ付きの形（`.../auth/callback?**`、`.../auth/confirm?**`）を追加した。

#### 本番 Supabase（ダッシュボード）での設定手順

`supabase/config.toml` はローカル CLI 専用で、ホステッド環境には適用されない。
本番・ステージングのプロジェクトでは、以下を**手作業で**合わせる必要がある。

1. Authentication → URL Configuration
   - Site URL に本番の `NEXT_PUBLIC_APP_URL` と同じ値を設定する。
   - Redirect URLs に `<APP_URL>/auth/callback`、`<APP_URL>/auth/callback?**`、
     `<APP_URL>/auth/confirm`、`<APP_URL>/auth/confirm?**` を登録する。
2. Authentication → Emails → Templates
   - **Confirm signup**: `supabase/templates/confirmation.html` の本文を貼り付ける
     （`{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=signup`）。
   - **Reset password**: `supabase/templates/recovery.html` の本文を貼り付ける
     （`{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery`）。
   - **Change email address**: `supabase/templates/email_change.html` の本文を貼り付ける
     （`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change`）。
   - **Magic Link**: 既定の `{{ .ConfirmationURL }}` のままにする。
     ここを `{{ .TokenHash }}` 形式に変えると `/auth/callback` が `missing_code` で失敗する。
3. Authentication → Providers → Email で「Confirm email」を有効にする。
4. テンプレート変更後、実アドレス宛に 3 種のメールを送って着地先を確認する（下記の検証ケース）。

#### 実ブラウザでの検証ケース（未実施）

`supabase start`（Docker 必須）で立ち上げ、ローカルのメール受信箱
（`http://localhost:54324`。`supabase/config.toml` の `[local_smtp]`。
Supabase CLI 2.x で `[inbucket]` から改称された）で受信メールのリンクを
実際に踏んで、以下を確認する。

| #   | フロー            | 操作                                                                              | 期待する着地                                                                                                                                              |
| --- | ----------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | サインアップ確認  | `/auth` でメール+パスワード登録 → 受信メールのリンク                              | `/auth/confirm?token_hash=…&type=signup&next=…` を経て `next`（既定 `/auth/session`）へ。セッションが確立している                                         |
| b   | Magic Link        | `/auth` の Magic Link 送信 → 受信メールのリンク                                   | Supabase の `/auth/v1/verify` を経て `/auth/callback?next=…&code=…` → `next` へ。セッションが確立している                                                 |
| c   | パスワード再設定  | `/auth/forgot-password` で送信 → 受信メールのリンク                               | `/auth/confirm?…&type=recovery` を経て **`/auth/update-password`** へ（`next` の指定によらず recovery は常にここ）。新パスワード設定後 `/auth/session` へ |
| d   | `next` の持ち回り | `/measurements` へ未認証アクセス → `/auth?next=%2Fmeasurements` から a / b を実施 | 認証後 `/measurements` へ着地する                                                                                                                         |
| e   | `next` の丸め     | `next=//evil.example` を付けて a / b を実施                                       | 外部へ出ず `/auth/session` へ着地する（実装仕様書 5.1節）                                                                                                 |

#### 期限切れ・再利用リンクの扱い（未実施）

`otp_expiry`（`supabase/config.toml` で 3600 秒）を過ぎたリンク、および一度使用済みの
リンクは、Supabase 側で検証が失敗する。アプリ側の期待動作は以下のとおりで、
これも実ブラウザで確認する。

| #   | 状況                                                            | 期待する挙動                                                                                                                            |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| f   | 期限切れの signup / recovery リンク                             | `verifyOtp()` が失敗 → `/auth?error=verification_failed` へ。ログイン画面が「有効期限が切れているか、すでに使用されています」と表示する |
| g   | 一度使用した signup / recovery リンクの再訪                     | 同上（`verification_failed`）。二重にセッションが発行されない                                                                           |
| h   | 期限切れ・使用済みの Magic Link                                 | `exchangeCodeForSession()` が失敗 → `/auth?error=exchange_failed`                                                                       |
| i   | `token_hash` / `type` を欠いた `/auth/confirm` への直接アクセス | `/auth?error=invalid_link`                                                                                                              |
| j   | `code` を欠いた `/auth/callback` への直接アクセス               | `/auth?error=missing_code`                                                                                                              |
| k   | 期限切れリンクから `/auth/update-password` を直接開く           | セッションが無いため `updatePasswordAction` が「再設定用リンクの有効期限が切れています」を返す                                          |

エラー文言はログイン画面（`src/app/auth/page.tsx`）が `?error=<コード>` を
`AUTH_ERROR_MESSAGES`（`src/features/auth/constants.ts`）で変換して表示する。
既知のコード以外は無視し、クエリの内容そのものは画面へ出さない（実装仕様書 9.2節）。

#### 実施できない理由と、現時点で確認できたところまで

`supabase start` は Docker を必須とするが、現在の開発環境には Docker / Podman が
（WSL 内も含めて）存在しない。Supabase CLI 自体は `npx supabase` で取得できるため、
**Docker 導入後は追加のコード変更なしに上記を実施できる**。

現時点で確認済み:

- `npx supabase@2.116.0 status` が `supabase/config.toml` を解析でき、
  追加した `[auth.email.template.*]`（`subject` / `content_path`）と
  `additional_redirect_urls` のクエリ付きエントリを受け付ける
  （エラーは Docker 未検出の一点のみ）。
- 各 Server Action が渡す `emailRedirectTo` / `redirectTo` の着地先と `next` は
  `src/features/auth/actions.test.ts` で固定済み。
- `/auth/callback`・`/auth/confirm` の失敗時の `?error=` コードと
  ログイン画面の文言変換は `src/features/auth/constants.ts` の型で結び付けてある。

Docker 導入後の実行手順:

```bash
npx supabase start          # 初回はイメージ取得のため時間がかかる
npm run dev                 # NEXT_PUBLIC_APP_URL=http://localhost:3000 を設定しておく
# http://localhost:3000/auth から a〜e を実施し、http://localhost:54324 で受信を確認する
npx supabase stop
```

### P2-6 詳細: `NEXT_PUBLIC_APP_URL` の必須化と `env:check`

実装仕様書 7章の same-origin 検証は「アプリのオリジン」との比較で成立する。
その比較対象を**リクエスト由来のヘッダーから採ってはならない**。

- `src/lib/app-origin.ts` の `getTrustedAppOrigin()` は `NEXT_PUBLIC_APP_URL` のみを
  信頼し、未設定なら `null` を返す。`X-Forwarded-Host` / `X-Forwarded-Proto` は
  リダイレクト先の組み立てを含め、どの経路でも参照しない。
- `src/server/api/guards.ts` の `isSameOriginRequest()` は比較対象が `null` のとき
  **常に false**を返す（フェイルクローズ）。結果として `NEXT_PUBLIC_APP_URL` が
  未設定の環境では、`DELETE /api/account`・`DELETE /api/account/data`・
  `GET /api/account/export` を含む全ての状態変更・出力APIが
  403 `SAME_ORIGIN_REQUIRED` を返す。
- したがって **本番・ステージングでは `NEXT_PUBLIC_APP_URL` を必須**とする。
  ローカル開発でも `http://localhost:3000` を設定しておくこと（`.env.example` に明記済み）。
- 回帰テスト: `src/lib/app-origin.test.ts`、
  `src/server/api/guards.test.ts`「X-Forwarded-Host / X-Forwarded-Proto では比較対象を書き換えられない」
  「NEXT_PUBLIC_APP_URL 未設定なら検査自体を失敗させる（フェイルクローズ）」。

残作業（`npm run env:check` の本実装。実装仕様書 13.1節）:

1. `--environment production` / `staging` では `NEXT_PUBLIC_APP_URL` の**欠落を致命エラー**にする。
   併せて https スキームであること、末尾スラッシュ等で `origin` がぶれないことを確認する。
2. 同様に `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` /
   `SUPABASE_SECRET_KEY` の欠落を検出する。
3. 本番では `fake` プロバイダー・プレースホルダー値・テスト専用プロバイダーを拒否する。
4. 値そのものは出力せず、欠落・不正の**事実のみ**を報告する（実装仕様書 13.1節）。

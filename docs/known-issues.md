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

| #    | 項目                                                | 現状                                                                                                                                                                                                                      | 着手の前提                                             | 該当節                       |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| P2-1 | 健康データ削除の本実装                              | `DELETE /api/account/data` は same-origin・Content-Type・64KiB・認証・利用者状態・再認証まで検査し、本体は 501 を返す                                                                                                     | 機能テーブルと削除RPC（`service_role` 限定）           | 実装仕様書 5.1節・9.2節      |
| P2-2 | アカウント削除の本実装                              | `DELETE /api/account` も同様に 501。Google接続revoke → Storage削除 → Auth Admin API による削除 → CASCADE → セッション破棄の順序は未実装                                                                                   | 機能テーブル・Google連携・Storage実体                  | 実装仕様書 5.1節・5.11節     |
| P2-3 | データ出力の対象拡大とページング                    | `GET /api/account/export` の対象は `users` / `user_profiles` のみ。1テーブル25,000行・合計100,000行・ページサイズ500行の上限は定数のみ用意した                                                                            | 機能テーブル                                           | 実装仕様書 5.1節             |
| P2-4 | プロフィール編集UIの本実装                          | `/demo` は候補提示・確認保存・JSON出力・ブラウザ内削除の骨格。`ProfileWorkspace` と 5.2節の検証は未実装                                                                                                                   | 実装仕様書 5.2節の着手（`/onboarding` と共通化）       | 実装仕様書 3.1節・5.2節      |
| P2-5 | 認証フローのE2E（メールリンクの実地確認）           | **実地検証済み（2026-08-27）**。ローカル Supabase + Mailpit + 実ブラウザで a〜e・f〜k の43ケースを確認。検証中に見つかった Magic Link の不具合（未登録・メール未確認の宛先で `missing_code`）は修正済み（下記 P2-5 詳細） | 完了。Playwright のシナリオ化（`e2e/`）は Phase 3 以降 | 実装仕様書 4章・5.1節・12章  |
| P2-6 | `env:check` の実装と `NEXT_PUBLIC_APP_URL` の必須化 | Phase 0 の雛形のまま。`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_APP_URL` の欠落検出は未実装（下記 P2-6 詳細）                                                                    | 実装仕様書 13.1節の全変数の要否確定                    | 実装仕様書 12章・13.1節・7章 |

### P2-5 詳細: メールテンプレート設定と実ブラウザ検証（実施済み）

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
3. Authentication → Providers → Email で「Confirm email」を有効にする。
4. テンプレート変更後、実アドレス宛に 3 種のメールを送って着地先を確認する（下記の検証ケース）。

#### 実施した検証（2026-08-27）

Docker Desktop 導入後、`npx supabase@2.116.0 start` でローカル Supabase を起動し、
`npm run dev`（`NEXT_PUBLIC_APP_URL=http://localhost:3000`）に対して
実ブラウザ（Playwright / Chromium）で `/auth` のフォームを操作し、
受信箱に届いたメール本文のリンクを実際に踏んで確認した。

検証環境:

- Supabase CLI 2.116.0 / gotrue v2.196.0 / postgres 17.6.1.165
- **ローカルの受信箱は Mailpit v1.30.2**（`http://localhost:54324`）。
  `supabase start` の出力は `MAILPIT_URL` と `INBUCKET_URL` の両方を同じURLで返し、
  コンテナ名は `supabase_inbucket_<project>` のままだが、中身は Mailpit へ置き換わっている。
  受信メールの取得は Mailpit の API（`/api/v1/search?query=to:<addr>`、
  `/api/v1/message/<id>`）を使う。Inbucket の `/api/v1/mailbox/<name>` は無い。

結果は **43 ケースすべて期待どおり**（うち 1 件は下記の不具合を修正してから成立）。

| #   | フロー                         | 実際に踏んだリンクと着地                                                                                                                                                                                                                                                                                                     | 判定 |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| a   | サインアップ確認               | 件名「【Health Web App】メールアドレスの確認」。`http://localhost:3000/auth/confirm?next=%2Fauth%2Fsession&token_hash=pkce_9da064d9…&type=signup` → `/auth/session` に「ログインしています。」と登録アドレスが表示される                                                                                                     | ○    |
| b   | Magic Link（確認済み宛先）     | 件名「【Health Web App】ログイン用リンク」。`http://127.0.0.1:54321/auth/v1/verify?token=pkce_f641ecdb…&type=magiclink&redirect_to=…%2Fauth%2Fcallback%3Fnext%3D%252Fauth%252Fsession` → 303 → `/auth/callback?code=422407c3-…&next=%2Fauth%2Fsession` → 307 → `/auth/session`                                               | ○    |
| b'  | Magic Link（未登録宛先）       | 件名は「メールアドレスの確認」。`http://localhost:3000/auth/callback?next=%2Fauth%2Fsession&token_hash=pkce_bf492e2d…&type=signup`（`code` 無し）→ `/auth/session`                                                                                                                                                           | ○ ※  |
| b'' | Magic Link（未確認の登録済み） | 同上の形。`/auth/callback?...&token_hash=…&type=signup` → `/auth/session`                                                                                                                                                                                                                                                    | ○ ※  |
| c   | パスワード再設定               | 件名「【Health Web App】パスワードの再設定」。`http://localhost:3000/auth/confirm?next=%2Fauth%2Fupdate-password&token_hash=pkce_924080a8…&type=recovery` → `/auth/update-password` → 新パスワード設定 → `/auth/session`。新パスワードで再ログイン成功、旧パスワードは「メールアドレスまたはパスワードが正しくありません。」 | ○    |
| d   | `next` の持ち回り              | 未認証で `/measurements` → `/auth?next=%2Fmeasurements`。code 形式・token_hash 形式のどちらのリンクでも認証後 `/measurements` へ着地（画面自体は後続フェーズで未実装）                                                                                                                                                       | ○    |
| e   | `next` の丸め                  | `/auth?next=%2F%2Fevil.example` から送信したリンクは、code 形式では `redirect_to=…/auth/callback?next=%2Fauth%2Fsession`、token_hash 形式では `next=/auth/session` に丸められ、着地も自オリジンの `/auth/session`。`evil.example` はリンクにも着地にも現れない                                                               | ○    |

※ b' / b'' は下記「見つかった不具合」で修正した経路。

#### 期限切れ・再利用リンクの扱い（実施済み）

期限切れは `supabase/config.toml` の `otp_expiry` を一時的に 60 秒へ下げ、
`supabase stop && supabase start` で反映してから 75 秒待って踏んだ（検証後 3600 秒へ戻した）。

| #   | 状況                                                            | 実際の挙動                                                                                                                                                                               | 判定 |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| f   | 期限切れの signup / recovery リンク                             | 両方とも `/auth?error=verification_failed`。「リンクを確認できませんでした。有効期限が切れているか、すでに使用されています。…」を表示                                                    | ○    |
| g   | 一度使用した signup / recovery リンクの再訪                     | 同上（`verification_failed`）。再訪したコンテキストから `/auth/session` を開くと `/auth?next=%2Fauth%2Fsession` へ丸められ、セッションは発行されていない                                 | ○    |
| h   | 期限切れ・使用済みの Magic Link                                 | code 形式は `/auth?error=exchange_failed`（Supabase が `#error=…&error_code=otp_expired` をフラグメントで付けるが、画面には出ない）。token_hash 形式は `/auth?error=verification_failed` | ○    |
| i   | `token_hash` / `type` を欠いた `/auth/confirm` への直接アクセス | `/auth?error=invalid_link`。未知の `type` も同じ。存在しない `token_hash` は `verification_failed`                                                                                       | ○    |
| j   | `code` を欠いた `/auth/callback` への直接アクセス               | `code` も `token_hash` も無ければ `/auth?error=missing_code`。`?error=access_denied&error_description=…` は `exchange_failed` になり、`error_description` の値は画面に出ない             | ○    |
| k   | 期限切れリンクから `/auth/update-password` を直接開く           | 「再設定用リンクの有効期限が切れているか、リンクから開かれていません。」を表示し、更新フォーム自体を出さない                                                                             | ○    |

`/auth?error=<script>alert(1)</script>` のような未知のコードは無視され、
クエリの内容は画面に一切出ない（実装仕様書 9.2節）ことも併せて確認した。

#### 見つかった不具合と修正

**症状**: Magic Link を **未登録のアドレス**、または **登録済みだがメール未確認のアドレス**
に対して送ると、リンクを踏んでも `/auth?error=missing_code` で行き止まりになり、
ログインできない。とくに「サインアップしたが確認メールのリンクを踏んでいない」利用者は、
Magic Link を何度送り直しても同じ結果になり、**どのメールからもログインできない**状態に陥る。

**原因**: GoTrue は宛先が未登録・メール未確認のとき、`signInWithOtp()`（Magic Link）の
要求であってもテンプレートに `magic_link` ではなく **`confirmation`（サインアップ確認）**
を選ぶ。`confirmation.html` は `{{ .RedirectTo }}&token_hash=…&type=signup` を組み立てるが、
この `RedirectTo` は Magic Link の Server Action が渡した `/auth/callback?next=…` である。
結果として **`code` を持たない `token_hash` 形式のリンクが `/auth/callback` へ届く**。
`/auth/callback` は `code` 前提だったため `missing_code` で弾いていた。

上の表の「ルート ↔ 検証方式」の対応は**送信側の意図としては正しい**が、
どちらのテンプレートが選ばれるかは宛先の状態しだいで、アプリからは制御できない。

**修正**:

- `src/features/auth/email-otp.ts` を新設し、`token_hash` + `type` の検証
  （`verifyOtp()`・`type=recovery` の `/auth/update-password` 固定・`next` の丸め）を切り出した。
- `src/app/auth/confirm/route.ts` はこの共通処理を使うように書き換えた（挙動は変えていない）。
- `src/app/auth/callback/route.ts` は、`code` が無くても `token_hash` があれば
  同じ検証へ回すようにした。`code` も `token_hash` も無い場合は従来どおり `missing_code`。
- `supabase/templates/magic_link.html` のコメントに、このテンプレートが使われるのは
  宛先が登録済みかつ確認済みのときだけであることを追記した。

回帰テスト: `src/features/auth/email-otp.test.ts`、`src/app/auth/callback/route.test.ts`。

**本番 Supabase でも同じ挙動になる**（GoTrue のテンプレート選択はホステッド環境でも同じ）。
ダッシュボードで Magic Link テンプレートを既定のままにしていても、
未確認の利用者には Confirm signup テンプレートが送られる点に注意すること。

#### 再実行の手順

```bash
npx supabase@2.116.0 start   # Docker Desktop が起動していること
npm run dev                  # .env.local に NEXT_PUBLIC_APP_URL=http://localhost:3000 を設定
# http://localhost:3000/auth から a〜e を実施し、http://localhost:54324（Mailpit）で受信を確認する
npx supabase@2.116.0 stop
```

期限切れ（f）を再現する場合のみ、`supabase/config.toml` の `otp_expiry` を一時的に
小さくして `supabase stop && supabase start` で反映し、検証後に 3600 へ戻すこと。

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

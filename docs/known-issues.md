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

## Phase 3b（身体測定フロントエンド）備忘録

Phase 3b のレビュー指摘（CR-1 / 新規-1〜新規-11 / C1〜C4 / S1〜S10）はすべて対応済み。以下は**対応に伴い判明した開発環境・実行手順上の注意**であり、実装仕様書の要求自体は満たしている。

| #      | 項目                                                                       | 現状・対応                                                                                                                                                                                                                                                                                | 該当箇所・コマンド                                                |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| P3b-1  | E2E は production ビルドで実行する                                         | `next dev` では React Fast Refresh が CSP の `script-src` に `'unsafe-eval'` を要求し、ブラウザコンソールで `EvalError` が発生してクライアントが初期化できない。CSP は実装仕様書 9.1 節と一字一句同一のため、開発時のみ緩和せず、**`npm run build && npm run start`** で E2E を実行する。 | `e2e/measurements.spec.ts`、Next.js 公式ドキュメント              |
| P3b-2  | Playwright の baseURL は `localhost` を明示する                            | `playwright.config.ts` の既定を `http://localhost:3000` に設定した。`NEXT_PUBLIC_APP_URL` と一致させないと same-origin 検証で API が 403 になるため、既定値は `127.0.0.1` ではなく `localhost` とする。必要に応じて `PLAYWRIGHT_BASE_URL` で上書き可能。                                  | `playwright.config.ts`、`e2e/README.md`                           |
| P3b-3  | Windows PowerShell では `npm` コマンドが Execution Policy でブロックされる | `npm` の PowerShell スクリプト (`npm.ps1`) が Execution Policy で実行できない。回避策として **`node --run <script>`** を使用する。または `npm.cmd` を直接呼び出す。                                                                                                                       | `package.json`、CI 用 PowerShell スクリプト                       |
| P3b-4  | `/api/health` は未実装                                                     | 死活監視用エンドポイント `/api/health` は現在未実装。ローカルではルート `/` への接続でサーバー起動を確認する。                                                                                                                                                                            | `src/app/api/health/route.ts`（未作成）                           |
| P3b-5  | Recharts `ResponsiveContainer` のテスト時警告                              | テスト環境ではコンテナの幅・高さが 0 のため、`ResponsiveContainer` がコンソール警告を出す。これは表示上の警告であり、テスト結果には影響しない。実ブラウザ・production ビルドでは発生しない。                                                                                              | `src/features/body-measurements/components/measurement-chart.tsx` |
| P3b-6  | 複数タブ E2E での自動更新限界                                              | 身体測定データは別ブラウザタブ間で自動同期されない。409 競合シナリオでは、pageA で更新後に **pageB を `reload()` して最新状態を取得する**必要がある。これはアプリの仕様であり、リアルタイム更新は後続フェーズで検討する。                                                                 | `e2e/measurements.spec.ts`                                        |
| P3b-7  | `happy-dom` の `URL` コンストラクタ制限                                    | `downloadCsv` のユニットテストでは、`URL.createObjectURL` / `revokeObjectURL` を stub し、anchor click をモック化している。`happy-dom` 上の `URL` 実装が blob URL に対応していないため、実際のダウンロード動作は E2E または手動で検証する。                                               | `src/features/body-measurements/utils.test.ts`                    |
| P3b-8  | Zod v4 の UUID バリデーション                                              | Zod v4 の `z.uuid()` は **v4 UUID のみ**を許可する。テスト fixture や E2E で使用する ID は必ず v4 形式にする。ランダムな 16 進文字列はスキーマ検証で落ちる。                                                                                                                              | `src/features/body-measurements/schema.ts`                        |
| P3b-9  | PowerShell `Start-Process` での `ChildProcess.kill` ログ                   | バックグラウンドで Next.js サーバーを起動する際、`Start-Process` が即座に制御を返すため、bash ツール上に `ChildProcess.kill` のようなログが出力されることがある。プロセスは継続して動作しており、影響はない。                                                                             | ローカル開発用 PowerShell 操作                                    |
| P3b-10 | `/measurements` へのナビゲーションが未整備                                 | MobileNavigation 削除により、URL 直打ち以外の導線がトップページのリンクのみ。本格的なナビゲーションバー・メニューは Phase 4 以降で対応する。                                                                                                                                              | `src/app/page.tsx`                                                |
| P3b-11 | グラフの表形式代替表示が全件描画される                                     | `MeasurementChart` の表形式代替表示（`role="table"`）は、取得済みの `measurements` をページング制限なくそのまま描画する。件数が多い場合に性能・読みやすさの問題になりうる。                                                                                                               | `src/features/body-measurements/components/measurement-chart.tsx` |

## Phase 3b（身体測定フロントエンド）Nice-to-have バックログ

Phase 3b のレビューで挙がったが、**今回の PR では修正しない**項目を記録する。
実装仕様書の要求自体は満たしており、UX・保守性の観点から後続フェーズで検討する。

| #       | 項目                                                  | 内容                                                                                                                                                                                                                                                                         | 記録理由                                                                                     | 該当箇所                                                             |
| ------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| N1      | 単位表示が英語のまま                                  | 種別一覧・記録フォームの単位セレクトで `index` / `custom` / `percent` 等が生の英字表示になっている。`formatUnitLabel` 関数は存在するが未使用                                                                                                                                 | 日本語 UI に英字が混在し、利用者の誤解を招く。既存の変換資産を適用すれば低コストで修正できる | `src/features/body-measurements/components/type-manager.tsx` 等      |
| N2      | グラフの Y 軸単位表示が不正確                         | `measurement-chart.tsx` の Y 軸ラベルが `selectedType.defaultUnit` を参照しているが、描画値は `normalizedValue`（mass→kg、length→cm 等）                                                                                                                                     | `defaultUnit` が `lb` / `inch` のカスタム種別で軸ラベルと実際の値の単位が食い違う            | `src/features/body-measurements/components/measurement-chart.tsx`    |
| N3      | `photoReference` が自由入力テキスト                   | 実装仕様書 5 節が定める `storage://health-images/<uuid>/...` 形式を実際に生成するアップロード経路が無いため、手入力は 400 エラーの原因になりやすい                                                                                                                           | アップロード API 実装（後続フェーズ）までは入力を隠すか HTTPS URL のみに絞る方が安全         | `src/features/body-measurements/components/record-form.tsx`          |
| N4      | 値の小数桁数の検証がフォームに無い                    | 記録フォームの値入力欄で小数点以下の桁数制限をしていない。`62.4567` のような値もクライアント側では通る                                                                                                                                                                       | サーバー側の 400 エラーで初めて気づく体験になる。クライアント側でも事前検証すべき            | `src/features/body-measurements/components/record-form.tsx`          |
| N5      | `clientMutationId` が二重送信対策として機能していない | 送信のたびに `generateUuid()` で新規生成しているため、API 契約が意図する「再送は同じ UUID」という冪等性の仕組みが活かされていない                                                                                                                                            | ネットワーク不安定時の再送で重複登録リスクが残る。送信開始時の UUID を保持すべき             | `src/features/body-measurements/use-measurements.ts`                 |
| N6      | 削除確認が `window.confirm` に依存                    | ダークテーマ対応・フォーカス管理・E2E での扱いがブラウザ標準ダイアログ任せになっている                                                                                                                                                                                       | アクセシビリティ・テスト保守性の観点からカスタム確認モーダルに移行すべき                     | `src/features/body-measurements/components/measurements-page.tsx` 等 |
| N7      | `recharts` の依存が重い                               | `recharts` 採用により `redux` / `react-redux` / `immer` / `d3-*` 等約 24 パッケージがクライアントバンドルに追加される                                                                                                                                                        | 折れ線グラフ 1 本のコストとして、モバイル前提の PWA にはやや重い                             | `package.json`                                                       |
| N8      | `load()` に競合防止機構が無い                         | 並び順の切り替え等を素早く行うと、AbortController や世代カウンタが無いため古いリクエストの応答が新しいリクエストより後に返って表示を上書きする可能性がある                                                                                                                   | 非同期リクエストの結果整合性を保つため、リクエストの世代管理が望ましい                       | `src/features/body-measurements/use-measurements.ts`                 |
| N9      | E2E のタイムゾーン処理に不整合                        | `measuredAt` の生成に `toISOString().slice(0, 16)`（UTC）を使い、それを `datetime-local`（ローカル時刻として扱われる）入力欄に設定しているため、JST 環境では 9 時間ずれる                                                                                                    | テストデータの日時が意図とずれ、フィルタ等の検証に影響しうる                                 | `e2e/measurements.spec.ts`                                           |
| N10     | CSV の改行・エンコーディングが Excel と相性が悪い     | CSV の改行コードが `\n`（サーバー側は `\r\n`）で統一されておらず、UTF-8 BOM 無し。Excel で開くと日本語ヘッダーが文字化けしやすい。                                                                                                                                           | Excel で開くと日本語ヘッダーが文字化けしやすい                                               | `src/features/body-measurements/utils.ts`                            |
| NTH-1   | CSV 出力がフィルタを無視して全件出力する              | 「フィルタ・並び替え」カード内に CSV 出力ボタンがあるが、`handleExportCsv` は `order: "desc"` 固定で画面のフィルタ条件を反映しない                                                                                                                                           | 利用者がフィルタ後の一覧がそのまま出力されると誤解しやすい                                   | `src/features/body-measurements/components/measurements-page.tsx`    |
| NTH-2   | CSV の改行コードがサーバーと不一致                    | クライアント側は `\n`、サーバー側は RFC 4180 準拠の `\r\n` で改行しており形式が統一されていない。UTF-8 BOM も無く Excel で文字化けしやすい（N10 と重複するが CSV 仕様全体の課題として合わせて記録）。                                                                        | サーバー・クライアント間の CSV 形式を統一すべき                                              | `src/features/body-measurements/utils.ts`                            |
| NTH-3   | 通信エラーメッセージが不正確                          | Zod による応答パース失敗が `catch` 節に落ち、「サーバー応答の形式が不正」であるにも関わらず「通信に失敗しました。オフラインの可能性があります。」と誤ったメッセージが表示される                                                                                              | ステータス 200 でも malformed な応答の場合、オフラインと誤認させない適切なメッセージにすべき | `src/features/body-measurements/api.ts`                              |
| NTH-4   | サーバーエラーが記録タブで二重表示される              | ページ上部の `{error}` 表示と `RecordForm` の `serverError={error}` の両方で同じエラーが表示される                                                                                                                                                                           | 同じエラーが複数箇所に重複して表示され、画面が煩雑になる                                     | `src/features/body-measurements/components/measurements-page.tsx`    |
| NTH-5   | 競合状態がタブ間で共有されてしまう                    | `conflict` の状態がタブ横断で共有されているため、測定記録タブでの競合バナーが種別管理タブや目標タブにも意図せず表示される                                                                                                                                                    | タブごとに独立したエラー・競合表示にすべき                                                   | `src/features/body-measurements/components/measurements-page.tsx`    |
| NTH-6   | グラフの Y 軸単位表示の不一致                         | `selectedType.defaultUnit` を Y 軸ラベルに使っているが、描画される値は正規化済みの値（`normalizedValue`）。`defaultUnit` が `lb` / `inch` のカスタム種別で軸ラベルと実際の値の単位が食い違う（N2 と同一原因）                                                                | 正規化単位（`normalizedUnit`）を参照するよう修正すべき                                       | `src/features/body-measurements/components/measurement-chart.tsx`    |
| NTH-7   | 目標の削除に確認ダイアログが無い                      | 測定記録の削除には `window.confirm` による確認があるが、目標の削除には確認ステップが無く、誤操作で即座に削除される                                                                                                                                                           | 重要な削除操作には一貫して確認ステップを設けるべき                                           | `src/features/body-measurements/components/goal-manager.tsx`         |
| NTH-8   | `ConflictBanner` の ARIA 属性が重複・矛盾している     | `role="alert"`（assertive 相当）と `aria-live="polite"` が同時に指定されており、スクリーンリーダーへの通知優先度の意図が矛盾している                                                                                                                                         | どちらか一方に統一すべき                                                                     | `src/features/body-measurements/components/conflict-banner.tsx`      |
| NTH-9   | CSV 全件エクスポートのループに上限が無い              | `handleExportCsv` の `do...while(cursor)` ループに件数上限や打ち切り条件が無く、理論上非常に多い件数のデータに対して無限に近いループが発生しうる                                                                                                                             | 上限件数を設けるか、進捗表示を追加すべき                                                     | `src/features/body-measurements/components/measurements-page.tsx`    |
| 新規-10 | E2E がデータの入ったアカウントでは通らない            | 既存データがあるアカウントで `measurements.spec.ts` を実行すると、(a) 一覧アサートが日付フィルタを経由せず特定の行を探せない、(b) cleanup が 30 秒タイムアウトに対応していない、(c) コメントは「テストで作成した測定記録をすべて削除」としているが実装は全記録を削除している | クリーンなテストアカウント専用の前提を明示し、cleanup の堅牢性を高める必要がある             | `e2e/measurements.spec.ts`                                           |
| 新規-11 | 409 の E2E テストに約 5% の偽 PASS リスク             | 乱数で生成する `valueA` と `valueB` の範囲が重複しており、`valueA === valueB` になると再試行が成功していなくてもテストが PASS してしまう                                                                                                                                     | 一意な値を使うか、DB 状態を直接検証して競合解決を確認すべき                                  | `e2e/measurements.spec.ts`                                           |
| NTH-10  | 累積ページングが 409 後にリセットされる               | 競合解決で `load()` すると一覧が先頭ページに戻り、何ページまで読み込んでいたかが失われる                                                                                                                                                                                     | 再試行後もユーザーのスクロール位置・ページング状態を維持すべき                               | `src/features/body-measurements/use-measurements.ts`                 |
| NTH-11  | `datetime-local` の秒精度欠落                         | `toDateTimeLocalValue` / `parseDateTimeLocal` が `YYYY-MM-DDTHH:mm` までしか扱わないため、同じ分内の複数記録を区別できず重複判定に影響しうる                                                                                                                                 | 秒まで保持するか、入力欄の精度を明確にドキュメント化すべき                                   | `src/features/body-measurements/utils.ts`                            |
| NTH-12  | 新規作成競合での無駄な対象特定クエリ                  | 新規作成時は `id` が無いため対象特定クエリが成立しないが、`handleMutationError` 内で `options.typeId && options.measuredAt` の条件を満たすと発行されてしまう                                                                                                                 | 新規作成時は対象特定クエリを発行しない分岐を追加すべき                                       | `src/features/body-measurements/use-measurements.ts`                 |
| NTH-13  | 到達不能な `else` 分岐                                | `handleMutationError` 内のエラー分岐で論理的に到達しない `else` があり、網羅性が損なわれている                                                                                                                                                                               | 不要な分岐を削除するか、網羅チェックで除外すべき                                             | `src/features/body-measurements/use-measurements.ts`                 |
| NTH-14  | `env:check` が実質 no-op                              | `npm run env:check` は雛形のままで、必須環境変数の欠落を検出していない                                                                                                                                                                                                       | 実装仕様書 13.1 節に従い、本番・ステージング・ローカルでそれぞれ検証すべき                   | `scripts/validate-env.mjs`                                           |
| NTH-15  | CI に E2E が未組込                                    | Playwright E2E が CI ワークフローに組み込まれていない                                                                                                                                                                                                                        | `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` を secrets 化し、production build 後に実行する        | `.github/workflows/`                                                 |
| NTH-16  | `webServer.url` が 3000 固定                          | `playwright.config.ts` の `webServer.url` が `http://localhost:3000` にハードコードされており、`PLAYWRIGHT_BASE_URL` と不整合になりうる                                                                                                                                      | `baseURL` と同じ値を参照するか、設定値の整合性を確認すべき                                   | `playwright.config.ts`                                               |
| NTH-17  | `e2e/README` とトップページの文言の陳腐化             | 身体測定機能実装後も「Phase 0 では配置のみ」等の古い説明が残っている                                                                                                                                                                                                         | 現在の機能に合わせて README・トップページの文言を更新すべき                                  | `e2e/README.md`、`src/app/page.tsx`                                  |
| NTH-18  | `known-issues.md` 見出しの陳腐化                      | Phase 3b 節の見出しが「C1〜C4/S1〜S10 はすべて対応済み」のままで、CR-1・新規-1〜新規-11 等の対応履歴が追えない                                                                                                                                                               | 対応済みのレビュー指摘を網羅的に記載した見出しに更新すべき                                   | `docs/known-issues.md`                                               |
| NTH-19  | トップページに医療機器免責事項が無い                  | 健康データを扱うアプリとして、トップページに「医療機器ではない」等の免責事項が無い                                                                                                                                                                                           | 利用規約・免責事項を Phase 4 以降で整備すべき                                                | `src/app/page.tsx`                                                   |

## Phase 4-1a（睡眠・水分・体調バックエンド）レビュー指摘

Codex レビューの Critical 1件（C1）・Should-fix 5件（S1〜S5）はすべて対応済み
（`fix: address Codex review findings on 409 pinpoint, sleep constraint, and transaction atomicity`）。
再レビューで挙がった同時実行の2件（カスタム症状30件上限のレース、水分記録の冪等
再送とアーカイブの競合窓）も対応済み
（`fix: serialize custom type limit checks and handle idempotent replay on check constraint conflicts`）。
以下は**今回のPRでは対応せず、後続フェーズへ送る**項目。

> **同時実行テストの限界（DBテスト環境）。** `tests/db/` は PGlite（WASM の
> PostgreSQL）で走らせており、**接続を1本しか張れない**ため、2つのトランザクションを
> 本当に並行させて「ロック待ち」そのものを再現することはできない。そのため
> `tests/db/wellness.test.ts`「上限検査は所有者単位のロックで直列化される」は、
> 直列化の前提になる**所有者単位のアドバイザリロックが上限検査の前に取られていること**を
> `pg_locks` から確認し、あわせて並行 INSERT で片方が拒否されることを見ている。
> ロック待ちを含む本物の並行検証は、Docker と Supabase CLI がある環境での
> `supabase test db`（pgTAP）で行う。

| #      | 項目                                               | 内容                                                                                                                                                                                                                                                                                                                                                                                            | 記録理由・今回見送る判断                                                                                                                                                                                                                                                              | 該当箇所                                                                                                            |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P41a-1 | タイムゾーン検証が正規表現のみで実在性を見ていない | `timezoneSchema`（`IANA_TIMEZONE_PATTERN`）も DB の `*_timezone_format` CHECK 制約も、IANA 名の**書式**だけを見ている。`Foo/Bar` のように実在しないタイムゾーン名も受理される。実在性まで見るには `Intl.supportedValuesOf("timeZone")` による検証（クライアント／API層）と、DB 側では `pg_timezone_names` を引く関数が要る（CHECK 制約からは IMMUTABLE でないため直接呼べず、トリガーが必要）。 | 保存されるのは**表示用のタイムゾーン名**であり、値域外でも他利用者・他データへ影響しない（表示が既定へ倒れるだけ）。実在性検証を入れると DB 側はトリガー1つ、フロント側は選択UIの実装が要り、Phase 4-1b（画面）でタイムゾーン選択UIを作るときにまとめて入れる方が二重実装にならない。 | `src/features/wellness/schema.ts`、`supabase/migrations/20260903000100_wellness_core.sql`（各 `*_timezone_format`） |

## Phase 4-1b（睡眠・水分・体調フロントエンド）レビュー指摘（軽微）

Phase 4-1b のレビュー判定は「マージ可（軽微な指摘あり）」とし、コード修正は行わず本ファイルに記録する。

| #   | 項目                                                                             | 内容                                                                                                                                                                                                                                  | 記録理由・今回見送る判断                                                                                                | 該当箇所                                                                                        |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| S-1 | 冪等キーが編集切り替えをまたいで再利用される                                     | 睡眠・水分・体調ページの `entryMutationIdRef`（`clientMutationIdRef`） は `onEdit` 時にクリアされない。別の行の編集ボタンを押しても前の `clientMutationId` が残り、`idempotent_replay` により別の編集が黙って破棄される可能性がある。 | 既存データを編集する操作中の限界ケース。修正はフロント側の ref クリアのみだが、E2E で再現が難しく今回は記録にとどめる。 | `src/features/wellness/components/sleep-page.tsx`、`hydration-page.tsx`、`condition-page.tsx`   |
| S-2 | `convertDateTimeLocalToTimezone` の DST 境界で 1 時間ずれ                        | 日時文字列を `Date` 経由で変換しているため、夏時間の移行日の前後で 1 時間ずれることがある。新設した `toDateTimeLocalValueInTimezone` も同じ `Date` 経由のため、同種の経路が追加された。                                               | タイムゾーン変換を `Date` ではなく文字列ベース（または 2 パス化）に切り替える必要がある。                               | `src/features/wellness/utils.ts`                                                                |
| S-3 | `withTimezone` ヘルパーが `process.env.TZ` 未設定時に文字列 `"undefined"` を代入 | テスト用 `withTimezone` は元の `process.env.TZ` を保存して復元するが、元が `undefined` の場合に文字列 `"undefined"` を代入してしまい、後続テストのタイムゾーンを意図せず変える。                                                      | `original === undefined` の場合は `delete process.env.TZ` するように修正が必要。                                        | `src/features/wellness/utils.test.ts`、`sleep-form.test.tsx`、`condition-form.test.tsx`         |
| N-2 | CSV 出力のタイムゾーン表記が不揃い                                               | 睡眠・水分・体調 CSV は `recordedAt` / `sleepAt` 等の生 ISO 文字列をそのまま出力する。一覧表示では `formatDateTimeJa` でタイムゾーン変換後の現地表示をしているため、CSV と画面で時刻表記が異なる。                                    | 出力形式の統一（現地表示または `+HH:mm` 付きで統一）が必要。                                                            | `src/features/wellness/utils.ts` (`buildSleepCsv`, `buildHydrationCsv`, `buildConditionCsv`)    |
| N-3 | E2E がタイムゾーンシナリオを持たない                                             | `wellness.spec.ts` は JST 前提の値を使っており、非 JST 環境や DST 期間での実行を保証していない。                                                                                                                                      | テストデータ生成に `formatDateTimeJa` やタイムゾーン変換を組み込む必要がある。                                          | `e2e/wellness.spec.ts`                                                                          |
| N-4 | 記録一覧にタイムゾーン表示が無い                                                 | 睡眠・水分・体調一覧は時刻を現地表示しているが、どのタイムゾーンで表示されているかが利用者に示されていない。                                                                                                                          | 一覧ヘッダーまたは各行にタイムゾーン注記を追加すべき。                                                                  | `src/features/wellness/components/sleep-list.tsx`、`hydration-list.tsx`、`condition-list.tsx`   |
| N-5 | 種別の作成/アーカイブで冪等キーが再利用されない                                  | 飲み物種別・症状種別の作成/アーカイブ時も `clientMutationId` を使うべきだが、再送時に同一 UUID が送られない可能性がある。                                                                                                             | ネットワーク不安定時の重複作成・操作リスク。                                                                            | `src/features/wellness/components/condition-page.tsx`、`hydration-page.tsx`、`type-manager.tsx` |
| N-6 | タグ削除ボタンが 44px 未満                                                       | 自由記述症状タグの削除ボタンが小さく、タッチターゲットの 44×44px を満たしていない。                                                                                                                                                   | モバイル操作の誤タップリスク。                                                                                          | `src/features/wellness/components/condition-form.tsx`、`wellness.module.css`                    |
| N-7 | 睡眠側のテストカバレッジ不足                                                     | 睡眠一覧・グラフ・フォームの網羅テストが体調/水分に比べて少なく、特に時刻順序エラー・24 時間制限・タイムゾーン往復の境界が不足。                                                                                                      | テストを追加してカバレッジを引き上げる必要がある。                                                                      | `src/features/wellness/components/sleep-*.test.tsx`                                             |

### 破壊検証の実施結果

Phase 4-1b 対応中に以下の破壊検証を実施した。失敗したテストは修正後にすべて成功した。

- `sleep-form.test.tsx`: `withTimezone("UTC")` 下で Asia/Tokyo 記録を編集した際、就床/入眠/起床/離床の `datetime-local` 値が 9 時間ずれて失敗（例: `2026-09-01T22:30` を期待したが `2026-09-01T13:30`）。原因は `toDateTimeLocalValueInTimezone` / `convertDateTimeLocalToTimezone` の非対称性。修正後は Asia/Tokyo 以外のタイムゾーンでも往復成功。
- `condition-form.test.tsx`: 同じく UTC 環境で Asia/Tokyo 記録を編集した際、日時が 9 時間ずれて失敗（例: `2026-09-01T08:30` を期待したが `2026-08-31T23:30`）。またタイムゾーン末尾空白（`"Asia/Tokyo "`）が trim されず `onSubmit` が呼ばれない失敗、タグ入力の `aria-invalid` / `aria-describedby` が input 要素側に無い失敗も発生。修正後はすべて成功。
- `hydration-page.test.tsx`: 記録保存の冪等キーと目標保存の冪等キーが共通の ref で管理されており、記録保存失敗後に目標保存をしても記録の retry で同じ `clientMutationId` が使われず 2 回目の呼び出しが発生しない失敗。クイック追加でも別飲み物間で同一 `clientMutationId` が衝突する失敗。`sleep-page.tsx` / `hydration-page.tsx` で保存種別ごとに独立した `entryMutationIdRef` / `goalMutationIdRef` を持つよう修正後に成功。

検証ログファイル `tmp-*.log`（7 本）は作業ツリーに残っていたが、本コミットで削除した。

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

## Phase 4-1b（睡眠・水分・体調フロントエンド）Nice-to-have バックログ

Claude Code レビューで挙がったが**今回の PR では修正しない**項目を記録する。
実装仕様書の要求自体は満たしており、UX・保守性の観点から後続フェーズで検討する。

| #      | 項目                           | 内容                                                                                                                          | 記録理由                                                                    | 該当箇所                                              |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| N4b-1  | タブ切り替え時の URL 状態保持  | 睡眠／水分／体調のタブ切り替えを URL ハッシュまたはクエリに反映し、ブラウザバック・直接リンクで前回表示していたタブを復元する | 現状はローカル state のみで、ページリロードで記録タブに戻ってしまう         | `src/features/wellness/components/*-page.tsx`         |
| N4b-2  | 時系列一覧の並び順・フィルタ   | 睡眠・水分・体調の一覧に並び順（新しい順／古い順）や日付範囲フィルタを追加する                                                | データが増えた場合の閲覧性向上。現状は API 側で未対応のため併せて検討が必要 | `src/features/wellness/use-wellness.ts`               |
| N4b-3  | タイムゾーン選択 UI            | 睡眠・体調のタイムゾーンを自由入力ではなく `<select>` による IANA 名選択 UI にする                                            | 自由入力は誤りやすく、実在しない名前も入力できてしまう。P41a-1 とも関連     | `src/features/wellness/components/sleep-form.tsx` 等  |
| N4b-4  | 睡眠効率の推定根拠ツールチップ | 睡眠効率が「推定値」であることに加え、計算式（睡眠時間／就床〜離床時間）をツールチップで表示する                              | 数値の信頼性を利用者が正しく理解できるよう補助する                          | `src/features/wellness/components/sleep-list.tsx`     |
| N4b-5  | クイック追加の量カスタマイズ   | 水分のクイック追加で既定値以外の量を選べるようにする（例: 100ml / 200ml / 350ml の選択）                                      | 利用頻度の高い量を1タップで記録できると利便性が高い                         | `src/features/wellness/components/hydration-page.tsx` |
| N4b-6  | 体調スコアのトレンドグラフ     | 総合スコア等の時系列トレンドを折れ線グラフで表示する                                                                          | 現状は表形式のみ。視覚的な傾向把握に有効                                    | `src/features/wellness/components/condition-page.tsx` |
| N4b-7  | 症状の重み付け集計             | 体調の症状に重み（severity）がある場合、単純な有無ではなく重み付きで集計・表示する                                            | 重症度を反映した傾向分析が可能になる                                        | `src/features/wellness/components/condition-list.tsx` |
| N4b-8  | 目標達成率の可視化             | 睡眠・水分の目標に対する週次／月次の達成率を表示する                                                                          | 目標機能の価値を高める。現状は目標値の入力と表示のみ                        | `src/features/wellness/components/goal-manager.tsx`   |
| N4b-9  | CSV 出力の画面フィルタ連動     | CSV 出力が画面上のフィルタ条件を反映するようにする（現状は全件・降順固定）                                                    | 利用者がフィルタ後の一覧がそのまま出力されると誤解しやすい                  | `src/features/wellness/components/*-page.tsx`         |
| N4b-10 | 入力フォームのオートセーブ     | 編集中のフォーム内容を `localStorage` 等に一時保存し、誤って離脱しても復元できるようにする                                    | 長い入力で失敗した場合の再入力負荷を減らせる                                | `src/features/wellness/components/*-form.tsx`         |

## セキュリティ修正（next 16.3.5 / sharp 0.35.4）に伴う残課題

`npm audit --omit=dev` で検出された本番依存の脆弱性2件（next の critical 2件・sharp の high 1件）を
`8e61ee2` で解消し、`89b1dbc` で develop へ統合した。その際に判明した以下2点は本フェーズでは
コード修正を行わず記録にとどめる。マルチエージェント開発要件定義書 7章（品質ゲート）に基づき、
着手時は担当表と該当節を確認する。

| #     | 項目                                                           | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                              | 記録理由・今回見送る判断                                                                                                                                                                                                                                                                                      | 該当箇所                                                                                      |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SEC-1 | `@next/next/no-location-assign-relative-destination` の警告9件 | `eslint-config-next` を 16.2.10 から 16.3.5 へ更新したことで新規追加されたルール。内部ページ遷移に `window.location.href` を使っている箇所が警告となる。内訳は `use-measurements.ts` 3箇所（173行・224行・242行）、`use-wellness.ts` 6箇所（140行・192行・259行・475行・515行・554行）の計9件。`window.location.href` を `useRouter().push()`（レンダー中は `redirect()`）へ置き換える対応が今後必要。                                            | いずれも `warning` であり `npm run lint` は exit 0 で通過するため、セキュリティ修正のスコープでは修正しない。置き換えは遷移の挙動（フルリロード有無・セッション再取得のタイミング）に影響するため、401/409 後の復帰フローを含めた回帰確認とセットで行う必要がある。                                           | `src/features/body-measurements/use-measurements.ts`、`src/features/wellness/use-wellness.ts` |
| SEC-2 | dev 依存の脆弱性4件が未解消                                    | `npm audit`（dev 含む）で4件が残る。`js-yaml` 4.0.0-4.3.1 は high（GHSA-2883-xcg3-v3hh: `maxTotalMergeKeys` が空のマージ元に対して CPU 使用を制限しない）で `npm audit fix` で解消可能。`@vitest/mocker` / `vitest` / `@vitest/coverage-v8` は moderate（GHSA-82fw-gwwq-j7x9: モックのリダイレクト経由のパストラバーサル／任意ファイル読み取り）で、解消には `@vitest/coverage-v8@4.1.11` への更新が必要なため `npm audit fix --force` を要する。 | いずれも devDependencies 側であり本番成果物には含まれないため `npm audit --omit=dev` の対象外（同コマンドは 0件）。`--force` はテスト基盤（vitest 4.1.10 系）のバージョンを stated range 外へ動かすため、テスト690件の回帰確認が必要。次のメンテナンス機会に `npm audit fix` / `--force` での対応を検討する。 | `package.json`（`devDependencies`）                                                           |

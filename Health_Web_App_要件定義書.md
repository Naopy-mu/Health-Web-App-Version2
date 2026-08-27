# Health Web App 要件定義書

## 1. システム概要

ユーザーが日々の身体情報・運動・食事・体調・サプリメント等を記録し、スマートフォンを中心に健康状態やダイエットの進捗を継続的に管理するためのWebアプリケーション。

特にiPhoneからの利用を重視し、通常のWebサイトとしてだけでなく、ホーム画面へ追加して利用できる**PWA（Progressive Web App）**として提供する。

ユーザーごとにアカウントを作成し、各ユーザーの健康データは他のユーザーから完全に分離する。

システムは主に以下の機能から構成される。

- **A. 身体計測管理**
  - 体重・ウエスト・太もも等の記録
  - BMI計算
  - 目標値設定
  - 週平均・月平均・移動平均グラフ
- **B. 運動・ストレッチ管理**
  - ワークアウト記録
  - ストレッチ記録
  - 運動予定管理
- **C. 体調・生活管理**
  - 睡眠・体調等の記録
- **D. サプリメント管理**
  - サプリメント登録
  - 摂取記録・通知
- **E. 食事管理**
  - 食事・食品記録
  - カロリー・栄養情報
  - 食品画像認識
- **F. 食材・買い物管理**
  - パントリー管理
  - 買い物リスト
- **G. カレンダー**
  - 健康関連予定の表示
  - Google Calendar連携
- **H. レポート・分析**
  - 計測・運動・食事等の集計
  - グラフによる推移確認
- **I. AIアシスタント**
  - 登録された健康データを利用した補助的な情報提示
- **J. PWA・オフライン同期**
  - オフライン入力
  - IndexedDB保存
  - 再接続時同期
  - 競合検出・解決
- **K. アカウント管理**
  - 認証
  - データ所有者分離
  - アカウント削除

---

## 2. 技術構成

| 項目 | 内容 |
|---|---|
| フロントエンド | Next.js / React / TypeScript |
| バックエンド | Next.js Route Handler / Server Action |
| データベース | Supabase PostgreSQL |
| 認証 | Supabase Auth |
| ファイルストレージ | Supabase Storage |
| ローカル保存 | IndexedDB |
| ホスティング | Vercel |
| PWA | Web App Manifest / Service Worker |
| テスト | Vitest / Playwright |
| ブラウザE2E | Chromium / WebKit（Mobile Safari相当） |
| 外部カレンダー | Google Calendar API |
| AI連携 | Gemini等の外部AI / Ollama等を利用可能な構成 |
| Push通知 | Web Pushを利用可能な構成 |
| バージョン管理 | Git / GitHub |

### 2.1 対応環境

主な対象環境は以下とする。

- iPhone Safari
- iPhone PWA
- PC Chromium系ブラウザ
- Safari/WebKit相当環境

iPhoneを主要利用端末として想定するが、PCからも同一アカウントへアクセスできるものとする。

### 2.2 環境構成

以下の環境を分離する。

1. **Local**
   - 開発・自動テスト用
   - Local Supabaseを利用可能

2. **Staging**
   - Vercel staging
   - staging専用Supabase
   - productionデータとは完全分離

3. **Production**
   - 実利用環境
   - production専用Supabase
   - stagingの秘密鍵・データを共有しない

---

## 3. 認証・アカウント機能

### 3.1 ログイン

- Supabase Authを利用する
- メールアドレス・パスワードによる認証を基本とする
- 未認証ユーザーは保護ページへアクセスできない
- ログイン成功後は保護ページへ遷移する
- ブラウザ再読み込み後もセッションを維持する
- ログアウトすると認証Cookie・セッションを破棄する

### 3.2 データ所有者分離

全てのユーザーデータは`owner_id`等によって所有者を識別する。

- ユーザーAはユーザーBのデータを取得できない
- IndexedDB内のデータもユーザー単位で分離する
- API側だけでなくPostgreSQLのRLSでも制御する
- Storageのファイルもユーザー単位で分離する
- アカウント切替後に前ユーザーのキャッシュを表示しない

### 3.3 アカウント削除

設定画面からアカウントを削除できる。

削除時には確認操作を要求する。

削除対象:

- Supabase Authアカウント
- ユーザー所有のDBデータ
- ユーザー所有のStorageファイル
- IndexedDB内のローカルデータ
- オフライン同期キュー
- 競合データ
- ローカルキャッシュ

削除中に新たなバックグラウンド同期を開始してはならない。

削除完了後は認証画面へ戻し、削除された資格情報では再ログインできない状態とする。

---

# 4. データモデル

## 4.1 ユーザー

Supabase AuthのユーザーIDを各データの所有者識別に使用する。

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | Supabase AuthのユーザーID |
| created_at | timestamp | アカウント作成日時 |

アプリ固有プロフィール情報が必要な場合は別テーブルで管理する。

---

## 4.2 測定種別

ユーザーが記録する身体計測の種類。

例:

- 体重
- ウエスト
- 太もも
- 体脂肪率
- その他ユーザー定義項目

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| name | text | 項目名 |
| unit | text | kg / cm / %等 |
| archived | boolean | 非表示状態 |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

### 測定種別仕様

- ユーザーが独自項目を追加可能
- 項目名・単位を設定可能
- 編集可能
- アーカイブ可能
- アーカイブ済み項目を再有効化可能
- 他ユーザーの測定種別は表示しない

---

## 4.3 身体計測記録

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| measurement_type_id | UUID | 測定種別 |
| value | numeric | 計測値 |
| measured_at | timestamp | 計測日時 |
| condition | text | 任意の計測条件 |
| location | text | 任意の計測位置 |
| photo_url | text | 任意の写真参照 |
| row_version | integer | 同期競合判定用バージョン |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

### 身体計測仕様

- 新規登録
- 編集
- 削除
- CSV出力
- 日付順表示
- 週平均
- 月平均
- 7日移動平均
- 30日移動平均
- 目標値との比較
- BMI算出
- 単位変換

同一条件で重複データが登録されないようDB制約を設ける。

---

## 4.4 身体計測目標

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| measurement_type_id | UUID | 対象項目 |
| target_value | numeric | 目標値 |
| target_date | date | 任意の目標日 |
| created_at | timestamp | 作成日時 |
| updated_at | timestamp | 更新日時 |

### 目標仕様

- 項目ごとに目標値を設定可能
- 目標値を変更・削除可能
- グラフ上に目標値を表示可能
- 実測値と目標値を比較可能

---

## 4.5 運動記録

運動・ワークアウトを管理する。

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| name | text | 運動名 |
| duration_minutes | integer | 実施時間 |
| intensity | text | 任意の運動強度 |
| performed_at | timestamp | 実施日時 |
| memo | text | メモ |
| created_at | timestamp | 作成日時 |

対象例:

- ランニング
- 筋力トレーニング
- テニス
- 有酸素運動
- 自由登録運動

---

## 4.6 ストレッチ記録

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| name | text | ストレッチ名 |
| duration_minutes | integer | 実施時間 |
| performed_at | timestamp | 実施日時 |
| memo | text | メモ |

運動記録とは分けて管理できるものとする。

---

## 4.7 体調・生活記録

日々のコンディションを記録する。

対象例:

- 睡眠
- 体調
- 疲労
- その他生活状態

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| record_type | text | 記録種別 |
| value | numeric/text | 値 |
| recorded_at | timestamp | 記録日時 |
| memo | text | メモ |

---

## 4.8 サプリメント

登録しているサプリメントを管理する。

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| name | text | 名称 |
| amount | text | 摂取量 |
| schedule | text | 摂取予定 |
| active | boolean | 使用中か |
| created_at | timestamp | 登録日時 |

### サプリメント摂取記録

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| supplement_id | UUID | サプリメント |
| owner_id | UUID | 所有ユーザー |
| taken_at | timestamp | 摂取日時 |
| status | text | 摂取済み等 |

---

## 4.9 食事記録

朝食・昼食・夕食・間食等を登録する。

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| meal_type | text | 朝食/昼食/夕食/間食等 |
| eaten_at | timestamp | 食事日時 |
| memo | text | メモ |
| photo_url | text | 食事画像 |
| created_at | timestamp | 登録日時 |

### 食品情報

食事に含まれる食品を個別に登録可能とする。

主な情報:

- 食品名
- 量
- カロリー
- 栄養値
- 食事との紐付け

---

## 4.10 食品画像認識

食事画像をAIへ送信し、食品候補を抽出できる。

### 要件

- 画像認識結果は確定データとして自動保存しない
- ユーザーが内容を確認・修正してから登録する
- AIが利用できない場合も手動入力可能
- AI APIキーをクライアントへ公開しない
- 画像はユーザー単位でアクセス制御する

---

## 4.11 パントリー

現在所有している食品・食材を管理する。

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| name | text | 食品名 |
| quantity | numeric | 数量 |
| unit | text | 単位 |
| expiration_date | date | 任意の期限 |
| created_at | timestamp | 登録日時 |
| updated_at | timestamp | 更新日時 |

---

## 4.12 買い物リスト

| フィールド | 型 | 説明 |
|---|---|---|
| id | UUID | 主キー |
| owner_id | UUID | 所有ユーザー |
| name | text | 商品名 |
| quantity | numeric | 数量 |
| purchased | boolean | 購入済み |
| created_at | timestamp | 登録日時 |

### パントリーとの連携

- 買い物リストへ追加
- 購入済みに変更
- 必要に応じパントリーへ反映
- 重複データを防止する

---

## 4.13 カレンダー予定

健康関連の予定をカレンダー表示する。

対象例:

- 運動予定
- ストレッチ
- サプリメント
- 健康関連予定

Google Calendar連携が有効な場合、外部予定との連携を行う。

---

## 4.14 オフライン同期キュー

オフライン中に行われた変更を保存する。

| フィールド | 説明 |
|---|---|
| mutation_id | 変更を一意に識別 |
| owner_id | 所有ユーザー |
| entity_id | 対象レコード |
| operation | create/update/delete |
| payload | 変更内容 |
| base_row_version | 編集開始時のサーバーバージョン |
| idempotency_key | 重複送信防止キー |
| status | pending/conflict等 |
| created_at | ローカル作成日時 |

IndexedDBに保存し、オンライン復帰後にサーバーへ同期する。

---

## 4.15 同期競合

同一データを複数端末・複数状態から編集した場合、`row_version`を利用して競合を判定する。

### 競合ポリシー

**サーバー側データを無断で上書きしない。**

競合時には明示的な競合画面を表示する。

ユーザーは以下から選択する。

#### サーバー値を採用

- ローカル変更を破棄
- サーバー値をIndexedDBへ反映
- pending mutationを削除
- conflictを削除

#### ローカル変更を再適用

- 最新のserver row versionを基準に再送信
- 新しいrow versionを取得
- 成功後pending/conflictを削除

### 禁止事項

- silent overwrite
- 競合を無視した自動上書き
- 別ユーザーの競合データ表示

---

# 5. 画面構成

## 5.1 認証画面

- ログイン
- 必要に応じた初期設定
- 認証エラー表示
- セッション確認

---

## 5.2 ホーム

ユーザーが現在の健康状態を確認するトップ画面。

表示候補:

- 最新体重
- BMI
- 目標との差
- 最近の運動
- 今日の予定
- 食事状況
- サプリメント状況
- 簡易サマリー

モバイルでは情報量を調整し、重要度の高いものから表示する。

---

## 5.3 身体計測ページ

主な機能:

- 測定値登録
- 測定値編集
- 削除
- 測定種別選択
- 測定種別追加
- 目標値登録
- CSV出力
- 履歴
- グラフ
- 7日平均
- 30日平均
- 週平均
- 月平均
- BMI
- オフライン状態表示
- 同期待ち表示
- 競合表示

### 入力UI

iPhoneでも操作しやすいサイズを確保する。

数値入力には適切なモバイルキーボードを使用する。

---

## 5.4 運動・ストレッチページ

- 運動登録
- ストレッチ登録
- 過去記録閲覧
- 実施時間入力
- メモ
- カレンダー連携

---

## 5.5 体調・生活ページ

- 睡眠等の生活記録
- 体調記録
- 日付ごとの履歴
- 推移確認

---

## 5.6 サプリメントページ

- サプリメント登録
- 編集
- 無効化
- 摂取記録
- 今日の摂取状況
- 通知設定

---

## 5.7 食事ページ

- 朝食・昼食・夕食・間食登録
- 食品追加
- カロリー記録
- 食事画像追加
- AI画像認識
- 手動修正
- 履歴確認

---

## 5.8 パントリー・買い物ページ

### パントリー

- 食材一覧
- 数量
- 単位
- 消費期限
- 追加
- 編集
- 削除

### 買い物リスト

- 商品追加
- 購入済み切替
- パントリーとの連携

---

## 5.9 カレンダーページ

- 健康予定一覧
- 日別・月別表示
- 運動等の予定
- Google Calendar連携状態表示

Google Calendar連携が無効でも、アプリ内部のカレンダーは利用できる。

---

## 5.10 レポートページ

蓄積したデータを分析して表示する。

対象:

- 体重推移
- 身体サイズ推移
- BMI
- 移動平均
- 目標との差
- 運動実績
- 食事実績
- その他健康指標

グラフはスマートフォンでも横幅が崩れないようレスポンシブ表示する。

---

## 5.11 AIアシスタントページ

ユーザーが健康管理に関する情報を確認する補助機能。

### 要件

- AI機能が無効でも他機能を利用可能
- AI APIキーをブラウザへ公開しない
- AIの回答を医療診断として扱わない
- 登録データへのアクセスはログインユーザーの範囲に限定する

---

## 5.12 設定・アカウントページ

- アカウント情報
- 外部連携
- 通知設定
- データ管理
- アカウント削除

アカウント削除は誤操作防止のため確認操作を必須とする。

---

# 6. PWA・モバイル対応

## 6.1 PWA

以下を備える。

- Web App Manifest
- Service Worker
- ホーム画面追加
- standalone表示
- オフライン対応
- safe-area対応

iPhoneではホーム画面へ追加した際にも主要画面が操作できること。

---

## 6.2 モバイルナビゲーション

画面下部等にスマートフォン用ナビゲーションを配置する。

### 要件

- iPhoneのsafe-areaを考慮
- タップ領域を十分確保
- 認証途中の一時ページで不要なRSC prefetchを発生させない
- 通常画面では必要なナビゲーション性能を維持

---

# 7. オフライン機能

## 7.1 オフライン入力

ネットワークがない状態でも身体計測の新規登録・編集を行える。

### オフライン時

1. 入力値をIndexedDBへ保存
2. 画面へ即時反映
3. pending状態を表示
4. 同期キューへ登録
5. ネットワークエラーを通常のサーバー障害として表示しない

### オンライン復帰時

1. ネットワーク復帰を検知
2. pending mutationを読み込む
3. `/api/sync`へ同期
4. row versionを確認
5. 成功ならpendingを削除
6. 競合なら競合画面へ移行

---

## 7.2 オフライン再読込

ローカルデータがIndexedDBへ保存されている場合、ネットワークが利用できなくても保存済みデータを復元できる。

確認対象:

- 測定値
- pending mutation
- owner
- mutation ID
- idempotency key

リモート読み込みに失敗しても、ローカルデータの復元が正常なら危険エラーとして扱わない。

---

## 7.3 オフライン状態表示

ユーザーへ現在の状態を明示する。

例:

- オフライン
- 同期待ち
- 同期中
- 競合あり
- 同期済み

---

# 8. 通知・外部連携

## 8.1 Push通知

対応可能なブラウザではWeb Pushを利用する。

対象候補:

- 運動予定
- ストレッチ
- サプリメント
- その他リマインダー

Pushが無効でもアプリ本体は利用可能とする。

---

## 8.2 Google Calendar

ユーザーの明示的な許可を得て連携する。

- カレンダー予定作成
- 健康関連予定反映
- 認証解除可能

Google Calendarが未設定・無効の場合でもアプリ内部カレンダーは利用可能とする。

---

## 8.3 AI連携

AI機能はオプション機能とする。

外部AIが設定されていない環境でもアプリの主要機能は正常動作する。

---

# 9. セキュリティ

## 9.1 RLS

Supabase PostgreSQLの対象テーブルにはRow Level Securityを設定する。

基本ポリシー:

```text
authenticated user
AND
owner_id = auth.uid()
```

他ユーザーのデータをSELECT・INSERT・UPDATE・DELETEできないこと。

---

## 9.2 Storage

健康画像等はprivate bucketへ保存する。

対象例:

- `health-images`
- `food-images-private`

要件:

- public URLによる無制限公開は禁止
- signed URLを必要時のみ生成
- owner以外はアクセス不可
- anonymous accessは禁止

---

## 9.3 API

保護対象APIは未認証アクセスに対して401を返す。

例:

- `/api/measurements`
- `/api/sync`

入力値はサーバー側でも検証する。

---

## 9.4 秘密情報

以下をGitへ保存しない。

- Supabase Secret key
- Service role key
- AI API key
- OAuth client secret
- Push秘密鍵
- access token
- refresh token

`.env`等は`.gitignore`対象とする。

ブラウザで使用してよい公開キーと、サーバー専用秘密鍵を明確に分離する。

---

# 10. エラー処理

エラーを以下に分類する。

### Blocking Error

利用継続できない問題。

例:

- 認証失敗
- 401 / 403
- サーバー障害
- IndexedDB破損
- owner mismatch
- JSON/schema不正

### Offline Warning

オフラインによりリモートデータを取得できないが、ローカル操作を継続できる状態。

### Validation Error

入力値の不備。

### Conflict

サーバー値とローカル値が競合している状態。

各状態を単一の汎用エラーとして扱わず、UI上でも区別する。

---

# 11. デプロイ

## 11.1 Vercel

Vercelへデプロイする。

### Staging

プロジェクト例:

`health-web-app-staging`

stagingではproductionとは別のSupabaseを利用する。

### Production

本番環境ではproduction専用Supabaseを利用する。

---

## 11.2 環境変数

主な環境変数:

```text
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
```

必要に応じて以下を追加する。

```text
Google Calendar関連
Web Push関連
AI関連
```

秘密情報はVercelのEnvironment Variablesへ登録し、リポジトリには保存しない。

---

# 12. テスト要件

## 12.1 Unit Test

主要ロジックは自動テストを作成する。

対象例:

- バリデーション
- API
- 認証
- owner isolation
- IndexedDB
- sync queue
- rowVersion
- conflict
- account deletion
- Storage
- PWA
- browser diagnostic
- staging verification

---

## 12.2 Browser Acceptance

Playwrightを使用する。

対象ブラウザ:

- Chromium
- Mobile Safari相当WebKit

主要journey:

### PWA

- Manifest
- Service Worker
- runtime configuration非露出

### 認証

- ログイン
- 保護ルート
- セッション維持
- ログアウト
- アカウント切替

### オフライン同期

- オフライン新規登録
- オフライン編集
- 永続化
- 再接続
- 同期
- rowVersion更新

### 競合

- stale update検出
- 409
- conflict表示
- サーバー値採用
- ローカル値再適用
- conflict queue削除
- silent overwrite禁止

### 所有者分離

- owner Aのデータをowner Bへ表示しない
- IndexedDB namespaceを分離

### アカウント削除

- データ削除
- Storage削除
- Auth削除
- IndexedDB削除
- 再ログイン拒否

---

## 12.3 Acceptance成功条件

各ブラウザで対象テストが全成功すること。

例:

```text
Chromium:
3 passed
primary status: passed
cleanup status: complete

Mobile Safari:
3 passed
primary status: passed
cleanup status: complete
```

cleanup失敗時は、本体テストが成功していてもacceptance失敗とする。

---

# 13. Staging検証

実stagingでは次の順で検証する。

1. Deployment確認
2. `/api/health`
3. Manifest
4. Service Worker
5. RLS
6. Storage isolation
7. Signed URL
8. Chromium acceptance
9. Mobile Safari acceptance
10. Synthetic user cleanup

使用コマンド:

```text
npm.cmd run staging:verify:runtime
npm.cmd run staging:verify:acceptance
```

ローカル専用runnerと実staging用runnerは分離する。

---

# 14. iPhone実機Acceptance

自動テストとは別にiPhone実機で確認する。

- [ ] Safariでstaging URLを開ける
- [ ] ログインできる
- [ ] ホーム画面へ追加できる
- [ ] PWAとして起動できる
- [ ] safe-areaを含めUIが崩れない
- [ ] 身体計測を登録できる
- [ ] オフライン状態を認識できる
- [ ] オフラインで計測値を保存できる
- [ ] 再接続後に同期される
- [ ] 競合画面を操作できる
- [ ] サーバー値を採用できる
- [ ] ローカル値を再適用できる
- [ ] ログアウトできる
- [ ] 別アカウントへ切替できる
- [ ] 前ユーザーのデータが表示されない
- [ ] アカウント削除ができる
- [ ] 削除済みアカウントで再ログインできない

---

# 15. Git運用ルール

## 15.1 基本方針

- `main`へ直接コミットしない
- 作業単位でbranchを分ける
- Pull Request経由で統合する
- force pushを原則使用しない
- merge前にテストを実行する

---

## 15.2 コミット

Conventional Commits形式を基本とする。

例:

```text
feat: add offline measurement synchronization
fix: stabilize authenticated navigation
test: complete cross-browser staging acceptance
docs: finalize staging acceptance procedures
```

---

## 15.3 AIによる変更

AIエージェントが変更する場合も通常のGit運用を守る。

禁止:

- `git add .`による無差別stage
- `git add -A`
- 不要なforce push
- stashの無断削除
- 秘密情報のcommit
- test-results等の生成物のcommit

変更ファイルを明示してstageする。

---

# 16. 非機能要件

## 16.1 パフォーマンス

- iPhoneで日常的に利用できる応答速度を確保
- 不要なAPI通信を避ける
- 不要なNext.js RSC prefetchを抑制
- 長い一覧・グラフでも画面を著しくブロックしない

---

## 16.2 可用性

外部サービスの一部が利用できなくても、主要な健康記録機能は利用できること。

例:

- Google Calendar停止
- AI停止
- Push未設定

これらによって身体計測等の主要機能を停止させない。

---

## 16.3 データ整合性

- idempotency keyによる重複防止
- rowVersionによる競合検知
- unique constraint
- RLS
- transactionまたは安全な削除順序
- アカウント削除後にデータを残さない

---

## 16.4 プライバシー

健康情報はユーザー本人のみが閲覧できることを原則とする。

- 不要な公開URLを作成しない
- private Storageを使用
- ログへ健康情報・認証情報を不用意に出力しない
- E2E synthetic userの資格情報をログへ出力しない

---

# 17. 未確定・今後の検討事項

- Production環境への正式公開時期
- Push通知を利用する具体的な項目
- Google Calendar双方向同期の範囲
- AIアシスタントへ渡す健康データの範囲
- 食品画像認識結果の精度評価方法
- レポートの長期分析項目
- データバックアップ・エクスポート機能の拡充
- ユーザー自身による全データ一括エクスポート
- Apple Health / Health Connect等との将来的な連携
- App Store向けネイティブアプリ化の要否

---

# 18. リリース判定

Productionへ進む前に以下をすべて満たす。

- [ ] Unit Test成功
- [ ] TypeScript型検査成功
- [ ] Lint成功
- [ ] Format確認成功
- [ ] Production build成功
- [ ] Chromium local acceptance成功
- [ ] Mobile Safari local acceptance成功
- [ ] Staging runtime verification成功
- [ ] Staging Chromium acceptance成功
- [ ] Staging Mobile Safari acceptance成功
- [ ] Synthetic user cleanup成功
- [ ] RLS確認
- [ ] Storage isolation確認
- [ ] Signed URL確認
- [ ] iPhone実機acceptance成功
- [ ] 秘密情報がGitに含まれていない
- [ ] Pull Requestレビュー完了

すべて通過した状態でProductionへのマージ・デプロイを行う。
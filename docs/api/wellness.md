# 睡眠・水分・体調 API 契約（実装仕様書 5.5節 / 7章）

**Phase 4-1a（バックエンド）で確定した契約。** フロントエンド（睡眠・水分・体調の画面）は
本書と `src/features/wellness/schema.ts` を前提に実装する。

| 事項                 | 内容                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| 型・スキーマの正本   | [`src/features/wellness/schema.ts`](../../src/features/wellness/schema.ts)     |
| 単位・換算・睡眠時間 | [`src/features/wellness/units.ts`](../../src/features/wellness/units.ts)       |
| 既定カタログ         | [`src/features/wellness/defaults.ts`](../../src/features/wellness/defaults.ts) |
| DB スキーマ          | `supabase/migrations/20260903000100_wellness_core.sql` ほか3件                 |
| 共通のテーブル規約   | [`docs/database/table-conventions.md`](../database/table-conventions.md)       |
| 同じ設計の先行実装   | [`docs/api/measurements.md`](./measurements.md)（身体測定。Phase 3a）          |

`schema.ts` / `units.ts` / `defaults.ts` は**サーバー専用の依存を持たない**ため、
クライアントコンポーネントからそのまま import してよい。
`src/server/**` は import しないこと（`import "server-only"` によりビルドが落ちる）。

エンドポイントは **`/api/wellness` の1本**だけ。睡眠・水分・体調・目標・種別のすべてを
`resource` で切り替える（実装仕様書 7章の表）。

---

## 1. 共通事項

### 1.1 全メソッドに共通の境界（実装仕様書 7章）

| 事項             | 内容                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| same-origin 検証 | GET を含む**全メソッド**に適用。`fetch` は同一オリジンの相対URLで呼ぶこと  |
| `Content-Type`   | POST / DELETE は `application/json` 必須（無い・違う → 415）               |
| ボディ上限       | 64 KiB（65,536 バイト）。宣言値と実バイト数の両方で検査（超過 → 413）      |
| 応答ヘッダー     | 成功・失敗とも `Cache-Control: no-store`                                   |
| 所有者           | **常に検証済みセッションから導出**。ボディ・クエリに所有者IDを入れると 400 |
| 入力検証         | Zod `.strict()`。未知フィールドはすべて 400                                |

ブラウザからの呼び出し例（`Origin` はブラウザが自動で付ける）:

```ts
await fetch("/api/wellness", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ resource: "sleep", clientMutationId, entry }),
});
```

### 1.2 応答の形

成功は `{ "data": ... }`、失敗は `{ "error": { "code": ..., "message": ... } }`。
`message` は利用者へそのまま表示できる日本語で、入力値・健康データ・内部情報を含まない。

**成功応答の `data` は必ず `resource` を持つ**（GET / POST / DELETE のいずれも）。
フロントは `data.resource` で分岐すれば中身の型が確定する
（`schema.ts` の `wellnessListDataSchema` / `saveWellnessDataSchema` は
`resource` を判別子にした判別可能ユニオン）。

### 1.3 所有者IDを送ってはいけない（実装仕様書 3.2節）

`owner_id` / `ownerId` / `user_id` / `userId` / `owner` / `uid` / `sub` は
**ネストした位置も含めて** 400 で拒否される。行の主キー `id` は更新・削除で使うため
この対象ではない。

### 1.4 楽観ロック（実装仕様書 6.4節）

- 応答の各行は `rowVersion` を持つ。
- **更新するときは、直前に受け取った `rowVersion` を `expectedRowVersion` として送る。**
- 版番号が違う／行が消えている場合は **409**。
  行の不在と版番号違いは**区別されない**（他利用者の行の存在を漏らさないため）。
- 409 を受けたら **1.7節の対象特定クエリ**で最新の `rowVersion` を取り直して再試行する。
- `rowVersion` はサーバーだけが進める。送っても保存には使われない（比較のみ）。

### 1.5 冪等キー（実装仕様書 6.4節 / 8.1節）

- 保存系（`POST`）は任意で `clientMutationId`（UUID v4）を受ける。
- **1つのミューテーションにつき1つの UUID を生成し、再送時も同じ値を使う。**
- 既に適用済みの `clientMutationId` なら、サーバーは新しい行を作らず
  **同じ成功応答**（`outcome: "idempotent_replay"`、HTTP 200）を返す。
- 別利用者が同じ UUID を使っても衝突しない（所有者ごとに閉じた一意制約）。
  リソース間（睡眠／水分／体調／目標／種別）でも独立しているので、同じ UUID を
  別リソースへ使っても replay にはならない。
- **何世代前の再送でも成功応答になる。** 同じ行を `A → B → C` と続けて更新したあとに
  `A` で再送しても 409 にはならず、**`A` が当時返したのと同じ応答**が返る。
  サーバーは適用結果を `wellness_mutation_log` に履歴として持ち、
  更新の前に必ずそこを引く（行の `clientMutationId` は最後の値で上書きされるため、
  行だけを見ると過去のキーが「未適用」に見えてしまう）。
- **同時多重送信でも同じ**。2つのリクエストが同じ `clientMutationId` で同時に届いた場合、
  遅れた側は版番号が進んでいて 0 件更新になるが、サーバーは 409 を返さず
  冪等キーで既存の成功結果を引き直して `idempotent_replay` を返す。
- 409 が返るのは、**別の内容で本当に競合したとき**（冪等キーを送っていない、
  または別の冪等キーで同じ行を更新しようとしたとき）だけ。

> **replay が返すのは「そのミューテーションの当時の行」**で、現在の行ではない。
> `A → B → C` のあとに `A` で再送すると、応答の `rowVersion` は `A` を適用した
> 時点の値（例では 2）になる。**この `rowVersion` を次の更新の
> `expectedRowVersion` に使わないこと**（現在の版番号ではないため 409 になる）。
> 最新の状態が必要なら 1.7節の対象特定クエリで取り直す。

- 冪等キーを付けられるのは**作成・更新**のみ。`DELETE` は `clientMutationId` を
  受け付けない（削除は 0 件なら 409。既に消えている行の再送はエラーになる）。
- `resource: "seed_defaults"` も冪等キーを取らない（既定投入そのものが冪等）。

### 1.6 保存は「全置換」（PUT 相当）

`entry` / `goal` / `type` は**そのリソースのあるべき姿を丸ごと**送る。
**省略した任意フィールドは `null` または既定値になる**（前回の値は残らない）。

| 省略したもの                                       | 保存される値                     |
| -------------------------------------------------- | -------------------------------- |
| `note` / `quality` / `morningFeeling` / 各スコア   | `null`                           |
| `timezone`                                         | `"Asia/Tokyo"`（実装仕様書 1章） |
| `awakeningsCount` / `awakeMinutes`                 | `0`                              |
| `freeTextSymptoms`                                 | `[]`                             |
| `weekdays`（目標）                                 | `[0,1,2,3,4,5,6]`（毎日）        |
| `containsCaffeine` / `containsAlcohol`（水分記録） | その飲み物種別の既定値           |
| `sortOrder`（種別）                                | `1000`                           |

**例外は体調記録の `symptoms` だけ**。省略すると既存の症状リンクを**そのまま残す**
（`[]` を送れば全解除）。詳しくは6節。

### 1.7 409 のあとに対象行を特定する（**重要**）

Phase 3b（身体測定フロントエンド）では、409 のあとに「`limit` 付きの一覧を
取り直すだけ」では対象行を見失う不具合が繰り返し見つかった。対象が一覧の何ページ目に
あるか分からないためで、**最新の `rowVersion` を取れないまま再試行できなくなる**。

本 API はこれを設計段階で塞いでいる。DB 側に「所有者 + 記録日時（+ 種別）」の
一意制約があり、GET はその組み合わせをそのまま絞り込み条件として公開する。
**下表の条件で GET すれば、件数に関係なく必ず1件に到達できる。**

| リソース                | 絞り込み（すべて GET のクエリ）                                      | 対応する DB の一意制約                    |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| 睡眠記録                | `resource=sleep&sleepKind=<種別>&from=<sleepAt>&to=<sleepAt>`        | (owner_id, sleep_kind, sleep_at)          |
| 水分記録                | `resource=hydration&beverageTypeId=<種別>&from=<recordedAt>&to=<同>` | (owner_id, beverage_type_id, recorded_at) |
| 体調記録                | `resource=condition&from=<recordedAt>&to=<recordedAt>`               | (owner_id, recorded_at)                   |
| 睡眠の目標 / 水分の目標 | 応答の `sleepGoals` / `hydrationGoals`（全件返る。ページングしない） | (owner_id, start_date)                    |
| 飲み物種別 / 症状種別   | 応答の `beverageTypes` / `symptomTypes`（全件返る）                  | (owner_id, beverage_key) など             |

409 からの復帰手順:

1. 編集開始時に持っていた**永続値**（送信値ではなく、サーバーから受け取った値）で
   上表の絞り込み GET を投げる。`limit=1` でよい。
   - 送信値を使うと、利用者が日時や種別を編集していた場合に別の行を指してしまう。
2. 返ってきた1件の `rowVersion` を `expectedRowVersion` にして再送する。
3. 0件なら、その行は他の操作で**削除された**。編集を破棄して一覧へ戻す。

```ts
// 例: 睡眠記録の 409 から復帰する
const params = new URLSearchParams({
  resource: "sleep",
  sleepKind: original.sleepKind, // 編集開始時の永続値
  from: original.sleepAt,
  to: original.sleepAt,
  limit: "1",
});
const res = await fetch(`/api/wellness?${params}`);
const { data } = await res.json();
const latest = data.entries.find((entry) => entry.id === original.id) ?? null;
```

目標と種別はページングしないので、`GET /api/wellness` の応答に必ず全件が入る。
一覧から `id` で引き直せばよい（追加のリクエストは要らない）。

### 1.8 エラーコード一覧

| コード                         | HTTP | 発生条件                                                                                                             | 画面での扱い                           |
| ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `SAME_ORIGIN_REQUIRED`         | 403  | `Origin` / `Sec-Fetch-Site` が同一オリジンでない                                                                     | 実装バグ。相対URLで `fetch` する       |
| `AUTHENTICATION_REQUIRED`      | 401  | 検証済みセッションが無い                                                                                             | `/auth` へ誘導                         |
| `ACCOUNT_INACTIVE`             | 403  | `users.status` が `active` 以外                                                                                      | 処理中の案内を出す（実装仕様書 5.1節） |
| `ACCOUNT_SERVICE_UNAVAILABLE`  | 503  | Supabase 未設定（実装仕様書 3.3節）                                                                                  | デモモードへ誘導                       |
| `JSON_REQUIRED`                | 415  | `Content-Type` が `application/json` でない                                                                          | 実装バグ                               |
| `PAYLOAD_TOO_LARGE`            | 413  | ボディが 64 KiB 超                                                                                                   | 入力を分割する                         |
| `INVALID_REQUEST`              | 400  | JSON 不正／スキーマ不一致／未知フィールド／所有者IDの持ち込み／不正な `cursor`／既定種別の変更／終了日が開始日より前 | `message` をフォームエラーとして表示   |
| `WELLNESS_INVALID_SLEEP_RANGE` | 400  | 就床≦入眠＜起床≦離床の順序違反、24時間超、覚醒時間が睡眠時間以上                                                     | 日時入力欄へエラーを出す（4.2節）      |
| `WELLNESS_TYPE_NOT_FOUND`      | 404  | `beverageTypeId` / `symptomTypeId` / 更新対象の種別が所有者スコープに無い                                            | 種別一覧を取り直す                     |
| `WELLNESS_TYPE_ARCHIVED`       | 400  | アーカイブ済みの種別へ新規の記録を登録しようとした                                                                   | アーカイブ解除を促す（8.3節）          |
| `WELLNESS_TYPE_KEY_RESERVED`   | 400  | 既定カタログの項目キーをカスタム種別に使おうとした                                                                   | 別のキーを促す（2.3節）                |
| `WELLNESS_TYPE_LIMIT_REACHED`  | 400  | カスタム症状種別が30件に達している                                                                                   | 不要な症状のアーカイブを促す           |
| `WELLNESS_CONFLICT`            | 409  | 記録の版番号不一致、または対象行が無い（更新・削除）                                                                 | 1.7節の手順で復帰する                  |
| `WELLNESS_DUPLICATE_CONFLICT`  | 409  | 同一の所有者・種別・記録日時の記録が既にある                                                                         | 日時を変えるか既存を編集               |
| `WELLNESS_GOAL_CONFLICT`       | 409  | 終了日の無い目標が既にある／同じ開始日の目標が既にある／目標の版番号不一致                                           | 既存の目標を締めてから作るよう促す     |
| `WELLNESS_TYPE_CONFLICT`       | 409  | 同じ項目キーの種別が既にある／種別の版番号不一致・対象なし                                                           | 別のキーを促す／一覧を再取得           |

上表は**本APIから返りうるコードの全部**。`API_ERROR_CODES` にはこのほか
身体測定用のコード、`REAUTHENTICATION_REQUIRED`、`NOT_IMPLEMENTED` があるが、
本APIの経路からは返らない。

コードの定義は [`src/server/api/errors.ts`](../../src/server/api/errors.ts) の `API_ERROR_CODES`。
将来コードが増えうるため、フロントは**未知のコードを `message` の表示で扱えるようにしておく**
（`apiErrorResponseSchema` の `code` は `z.string()`）。

---

## 2. 種別カタログ

睡眠・体調と違い、**水分記録は必ず「飲み物種別」を参照する**。
体調記録の症状も「症状種別」を参照する。どちらも既定カタログ + カスタム追加の形で、
身体測定の測定種別（`docs/api/measurements.md` 2節）と同じ規則に従う。

### 2.1 `BeverageType` の応答形

飲み物種別を返すすべての場所（`GET` の `data.beverageTypes`、
`POST` の `data.type`、`seed_defaults` の `data.beverageTypes`）で**同じ形**。
正本は `schema.ts` の `beverageTypeSchema`。

```jsonc
{
  "id": "7e2d3c4b-5a69-4788-9900-aabbccddeeff", // UUID。記録の beverageTypeId に使う
  "beverageKey": "water", // 項目キー。既定10種は2.4節の表、カスタムは 2.3節の形
  "displayName": "水", // 1〜100字
  "defaultUnit": "ml", // "ml" | "l" | "us_fl_oz"。入力欄の初期値に使う
  "defaultAmount": 200, // 入力欄の初期値。未設定なら null
  "containsCaffeine": false, // 記録の containsCaffeine の既定値
  "containsAlcohol": false, // 記録の containsAlcohol の既定値
  "isDefault": true, // 既定カタログ由来なら true。クライアントからは指定・変更できない
  "sortOrder": 10, // 0〜100000。一覧の並び順（同値なら beverageKey 順）
  "archivedAt": null, // アーカイブ日時（ISO 8601、UTC の "Z" 表記）。有効な種別は null
  "rowVersion": 1, // 楽観ロックの版番号（1.4節）
  "clientMutationId": null, // その行を最後に変更したミューテーションの冪等キー（1.5節）
  "createdAt": "2026-09-03T00:00:00.000Z",
  "updatedAt": "2026-09-03T00:00:00.000Z",
}
```

### 2.2 `SymptomType` の応答形

```jsonc
{
  "id": "8e2d3c4b-5a69-4788-9900-aabbccddeeff",
  "symptomKey": "headache",
  "displayName": "頭痛",
  "isDefault": true,
  "sortOrder": 10,
  "archivedAt": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-03T00:00:00.000Z",
  "updatedAt": "2026-09-03T00:00:00.000Z",
}
```

どちらも全フィールド必須（省略されない）。`null` になりうるのは `archivedAt` /
`clientMutationId`（飲み物はさらに `defaultAmount`）だけ。日時はすべて `Z` 付きの
ISO 8601 で返る。

一覧（`data.beverageTypes` / `data.symptomTypes`）は
**`sortOrder` 昇順 → 項目キー昇順**で、**アーカイブ済みも含めた全件**。
画面側は `archivedAt !== null` を入力候補から外し、履歴の表示には引き続き使う。

### 2.3 カスタム項目キー

`^[a-z][a-z0-9_]{1,49}$`（英小文字始まり、2〜50文字）。所有者ごとに一意。

**既定カタログのキー（2.4節・2.5節の表）は予約語**で、カスタム種別には使えない
（400 `WELLNESS_TYPE_KEY_RESERVED`）。これを許すと、先に同じキーのカスタム種別を
作っておくことで既定種別になりすませてしまう。DB のトリガーも同じ形を拒否する。

TypeScript からは `isDefaultBeverageKey(key)` / `isDefaultSymptomKey(key)`
（`features/wellness/defaults.ts`）で入力欄の段階で弾ける。

**項目キーは作成後に変更できない。** 更新（`type.id` を指定）で
`beverageKey` / `symptomKey` を送ると 400 になる（過去の記録の意味が後から
変わってしまうため。DB の列レベル権限も UPDATE を許していない）。

### 2.4 既定の飲み物10種（実装仕様書 5.5節）

| `beverageKey`  | 表示名           | `defaultUnit` | `defaultAmount` | カフェイン | アルコール | `sortOrder` |
| -------------- | ---------------- | ------------- | --------------- | ---------- | ---------- | ----------- |
| `water`        | 水               | `ml`          | 200             | —          | —          | 10          |
| `green_tea`    | 緑茶             | `ml`          | 200             | ✓          | —          | 20          |
| `coffee`       | コーヒー         | `ml`          | 150             | ✓          | —          | 30          |
| `black_tea`    | 紅茶             | `ml`          | 200             | ✓          | —          | 40          |
| `barley_tea`   | 麦茶             | `ml`          | 200             | —          | —          | 50          |
| `milk`         | 牛乳             | `ml`          | 200             | —          | —          | 60          |
| `juice`        | ジュース         | `ml`          | 200             | —          | —          | 70          |
| `sports_drink` | スポーツドリンク | `ml`          | 500             | —          | —          | 80          |
| `soup`         | スープ           | `ml`          | 150             | —          | —          | 90          |
| `beer`         | ビール           | `ml`          | 350             | —          | ✓          | 100         |

### 2.5 既定の症状13種（実装仕様書 5.5節）

| `symptomKey`  | 表示名     | `sortOrder` |     | `symptomKey`   | 表示名 | `sortOrder` |
| ------------- | ---------- | ----------- | --- | -------------- | ------ | ----------- |
| `headache`    | 頭痛       | 10          |     | `fatigue`      | 倦怠感 | 90          |
| `stomachache` | 腹痛       | 20          |     | `joint_pain`   | 関節痛 | 100         |
| `nausea`      | 吐き気     | 30          |     | `muscle_pain`  | 筋肉痛 | 110         |
| `dizziness`   | めまい     | 40          |     | `diarrhea`     | 下痢   | 120         |
| `fever`       | 発熱       | 50          |     | `constipation` | 便秘   | 130         |
| `cough`       | 咳         | 60          |     |                |        |             |
| `runny_nose`  | 鼻水       | 70          |     |                |        |             |
| `sore_throat` | のどの痛み | 80          |     |                |        |             |

TypeScript からは `DEFAULT_BEVERAGE_TYPES` / `DEFAULT_SYMPTOM_TYPES`
（`features/wellness/defaults.ts`）で同じ内容を参照できる。
DB のカタログとの一致は `tests/db/wellness.test.ts` が検証している。

**カスタム症状種別は所有者ごとに30件まで**（実装仕様書 5.5節「既定13種＋任意30件まで」）。
超えると 400 `WELLNESS_TYPE_LIMIT_REACHED`。定数は `CUSTOM_SYMPTOM_TYPE_MAX`。

---

## 3. `GET /api/wellness` — 一覧の取得

**1回の GET で「1つの時系列リソース（ページング付き）＋ 種別カタログ全件 ＋ 目標全件」**が返る。
画面の初期表示はこれ1回で足りる。

### クエリパラメータ

| 名前             | 型                                  | 既定    | 内容                                             |
| ---------------- | ----------------------------------- | ------- | ------------------------------------------------ |
| `resource`       | `sleep` / `hydration` / `condition` | `sleep` | ページングして返す時系列リソース                 |
| `from`           | ISO 8601                            | —       | 時間軸 `>= from`（オフセット必須）               |
| `to`             | ISO 8601                            | —       | 時間軸 `<= to`（オフセット必須）                 |
| `order`          | `asc` / `desc`                      | `desc`  | 時間軸の並び                                     |
| `limit`          | 整数 1〜500                         | `100`   | 1ページの件数                                    |
| `cursor`         | 不透明文字列                        | —       | 前ページの `data.page.nextCursor` をそのまま渡す |
| `sleepKind`      | `night` / `nap` / `other`           | —       | `resource=sleep` のときだけ指定できる            |
| `beverageTypeId` | UUID                                | —       | `resource=hydration` のときだけ指定できる        |

**`from` / `to` が比較する列はリソースごとに違う。**

| `resource`  | 時間軸                |
| ----------- | --------------------- |
| `sleep`     | `sleepAt`（入眠日時） |
| `hydration` | `recordedAt`          |
| `condition` | `recordedAt`          |

未知のパラメータは 400。値の形が不正なもの（UUIDでない `beverageTypeId`、
オフセットの無い日時、範囲外の `limit`）も 400。
`resource` に合わない絞り込み（`resource=condition` に `sleepKind` など）も 400。

### 応答 `200`

```jsonc
{
  "data": {
    "resource": "sleep", // 判別子。entries の型がこれで決まる
    "entries": [/* 4.1節（sleep）/ 5.1節（hydration）/ 6.1節（condition）の形 */],
    "beverageTypes": [/* 2.1節。アーカイブ済みも含む全件 */],
    "symptomTypes": [/* 2.2節。アーカイブ済みも含む全件 */],
    "sleepGoals": [/* 7.1節。全件、startDate 降順 */],
    "hydrationGoals": [/* 7.2節。全件、startDate 降順 */],
    "context": {
      // 終了日の無い（＝現在有効な）目標。所有者ごとに1件までなので0件か1件
      "activeSleepGoal": {/* 7.1節 */},
      "activeHydrationGoal": null,
    },
    "page": { "limit": 100, "order": "desc", "nextCursor": null },
  },
}
```

種別カタログと目標は**どの `resource` でも常に同じ形で全件返る**。
時系列だけがページングの対象。

### ページング方式（キーセット／カーソル）

オフセットではなく **`(時間軸, id)` のキーセット方式**。追記が続く時系列でも
行の取りこぼし・重複が起きない。

1. 1ページ目は `cursor` を付けずに呼ぶ。
2. `data.page.nextCursor` が `null` でなければ次ページがある。
3. 次ページは同じ絞り込み条件に `cursor=<nextCursor>` を足して呼ぶ。
4. `nextCursor` が `null` になったら終端。

`cursor` は不透明な文字列。中身を組み立てたり書き換えたりしないこと（不正な値は 400）。
`resource` / `order` / `limit` / 絞り込み条件はページ間で変えないこと。

### 平均値・CSV 出力について

実装仕様書 5.5節の「平均値算出、CSV出力」は**フロント側の責務**
（身体測定の移動平均と同じ扱い。`docs/api/measurements.md` 10節）。
必要な列はすべて本応答に含まれる。

- 睡眠: `sleepMinutes` / `timeInBedMinutes`（DB の生成列）で平均も睡眠効率も出せる
- 水分: `amountMl`（ml 正規化値）を足すだけで合計・平均が出る
- 体調: 各スコアと `bodyTemperatureC`

`nextCursor` が `null` になるまでページを辿って全件を集め、クライアント側で整形する。

> CSV を組み立てるときは、実装仕様書 5.5節・9.2節の数式インジェクション対策
> （`=` `+` `-` `@` で始まる値へのクォート前置）を必ず適用すること。
> **比較結果を因果関係として断定しない**表現にすること（実装仕様書 5.5節・10章）。

---

## 4. 睡眠記録

### 4.1 `SleepEntry` の応答形

```jsonc
{
  "id": "…",
  "sleepKind": "night", // "night" | "nap" | "other"
  "bedAt": "2026-09-01T22:30:00.000Z", // 就床
  "sleepAt": "2026-09-01T23:00:00.000Z", // 入眠（時間軸。並び・絞り込みはこの列）
  "wakeAt": "2026-09-02T06:30:00.000Z", // 起床
  "outOfBedAt": "2026-09-02T06:45:00.000Z", // 離床
  "timezone": "Asia/Tokyo", // IANA 名
  "awakeningsCount": 1, // 中途覚醒回数 0〜30
  "awakeMinutes": 25, // 覚醒時間（分）0〜720
  "quality": 4, // 睡眠の質 1〜5。未入力は null
  "morningFeeling": 3, // 起床時の感覚 1〜5。未入力は null
  "note": null, // 500字
  "sleepMinutes": 425, // 起床 - 入眠 - 覚醒時間（DBの生成列）
  "timeInBedMinutes": 495, // 離床 - 就床（DBの生成列）
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-02T07:00:00.000Z",
  "updatedAt": "2026-09-02T07:00:00.000Z",
}
```

### 4.2 日時の規則（実装仕様書 5.5節）

> 就床≦入眠＜起床≦離床の順序、24時間超や覚醒時間が睡眠時間以上となる値を拒否する。

- **4つの日時はすべて必須**。仮眠のように就床＝入眠、起床＝離床の記録は同じ値を入れる
  （`<=` なので通る）。入眠＜起床だけは**厳密**（同時刻は 400）。
- 就床から離床までが 24 時間を超えると 400。
- `awakeMinutes` は入眠〜起床の分数**未満**でなければならない（等号も 400）。

いずれも 400 `WELLNESS_INVALID_SLEEP_RANGE` で、`message` にどの規則を破ったかが入る。
DB の CHECK 制約も同じ判定をする（最終防衛線）。

**保存前に同じ判定をフロントでもできる**:
`findSleepChronologyViolations({ bedAt, sleepAt, wakeAt, outOfBedAt, awakeMinutes })`
（`features/wellness/units.ts`）が破っている規則の識別子（`"order"` /
`"span_over_24_hours"` / `"awake_not_shorter_than_sleep"` / `"invalid_datetime"`）を返す。

### 4.3 `POST` — 睡眠記録の保存

作成と更新を兼ねる。`entry.id` の有無で分岐する。

```jsonc
{
  "resource": "sleep",
  "clientMutationId": "…", // 任意。オフライン再送の冪等キー（1.5節）
  "entry": {
    "id": "…", // 省略 → 作成 / 指定 → 更新
    "expectedRowVersion": 3, // 更新のときは必須、作成では送ってはいけない
    "sleepKind": "night", // 必須
    "bedAt": "2026-09-01T22:30:00Z", // 必須。オフセット必須の ISO 8601
    "sleepAt": "2026-09-01T23:00:00Z", // 必須
    "wakeAt": "2026-09-02T06:30:00Z", // 必須
    "outOfBedAt": "2026-09-02T06:45:00Z", // 必須
    "timezone": "Asia/Tokyo", // 任意（既定 Asia/Tokyo）
    "awakeningsCount": 1, // 任意 0〜30（既定 0）
    "awakeMinutes": 25, // 任意 0〜720（既定 0）
    "quality": 4, // 任意 1〜5
    "morningFeeling": 3, // 任意 1〜5
    "note": null, // 任意 500字
  },
}
```

応答 `201`（作成）／ `200`（更新・再送）:

```jsonc
{
  "data": {
    "resource": "sleep",
    "entry": {/* 4.1節と同じ形 */},
    "outcome": "created" | "updated" | "idempotent_replay",
  },
}
```

主な失敗:

| 状況                                      | 応答                               |
| ----------------------------------------- | ---------------------------------- |
| 版番号不一致・対象なし                    | 409 `WELLNESS_CONFLICT`            |
| 同じ種別・同じ入眠日時の記録が既にある    | 409 `WELLNESS_DUPLICATE_CONFLICT`  |
| 4.2節の日時規則を破っている               | 400 `WELLNESS_INVALID_SLEEP_RANGE` |
| `id` があるのに `expectedRowVersion` 無し | 400 `INVALID_REQUEST`              |
| `id` が無いのに `expectedRowVersion` あり | 400 `INVALID_REQUEST`              |

---

## 5. 水分記録

### 5.1 `HydrationEntry` の応答形

```jsonc
{
  "id": "…",
  "beverageTypeId": "…",
  "beverageKey": "water", // 種別を引き直さずにラベル・CSVを作れる
  "displayName": "水",
  "recordedAt": "2026-09-02T09:00:00.000Z", // 時間軸
  "unit": "l", // 入力単位のまま保存（実装仕様書 6.3節）
  "amount": 1.5, // 入力値のまま
  "amountMl": 1500, // 集計用の ml 正規化値（DBの生成列）
  "containsCaffeine": false,
  "containsAlcohol": false,
  "note": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-02T09:00:00.000Z",
  "updatedAt": "2026-09-02T09:00:00.000Z",
}
```

### 5.2 「飲み物名」は種別で表す

実装仕様書 5.5節の記録項目「飲み物名」は、**自由文字列ではなく
`beverageTypes` の `displayName`** で表す。`beverageTypeId` は必須。

そうしている理由は 1.7節。`(所有者, 飲み物種別, 記録日時)` を一意にすることで、
409 のあとに対象1件へ確実に到達できるようにしている。
一覧に無い飲み物を記録したい場合は、先に 8.2節でカスタム種別を追加する。

### 5.3 単位と正規化（実装仕様書 5.5節 / 6.3節）

| `unit`     | 表示         | ml 換算        |
| ---------- | ------------ | -------------- |
| `ml`       | mL           | ×1             |
| `l`        | L            | ×1000          |
| `us_fl_oz` | 米液量オンス | ×29.5735295625 |

`amount` は **0 超 10,000 以下、小数第3位まで**（DB の `numeric(10,3)`）。
`amountMl` は DB の生成列なので、保存済みの記録では**応答の値をそのまま使う**。
保存前のプレビューには `normalizeHydrationAmount(amount, unit)`（`units.ts`）を使う。

### 5.4 `POST` — 水分記録の保存

```jsonc
{
  "resource": "hydration",
  "clientMutationId": "…", // 任意
  "entry": {
    "id": "…", // 省略 → 作成 / 指定 → 更新
    "expectedRowVersion": 2, // 更新のときは必須
    "beverageTypeId": "…", // 必須
    "recordedAt": "2026-09-02T09:00:00Z", // 必須
    "unit": "l", // 必須。ml | l | us_fl_oz
    "amount": 1.5, // 必須。0超10,000以下、小数第3位まで
    "containsCaffeine": false, // 任意。省略すると種別の既定値
    "containsAlcohol": false, // 任意。省略すると種別の既定値
    "note": null, // 任意 500字
  },
}
```

応答 `201` / `200`:
`{ "data": { "resource": "hydration", "entry": {…}, "outcome": … } }`

主な失敗:

| 状況                                              | 応答                              |
| ------------------------------------------------- | --------------------------------- |
| `beverageTypeId` が所有者の種別に無い             | 404 `WELLNESS_TYPE_NOT_FOUND`     |
| `beverageTypeId` がアーカイブ済み（新規作成のみ） | 400 `WELLNESS_TYPE_ARCHIVED`      |
| 同じ種別・同じ記録日時の記録が既にある            | 409 `WELLNESS_DUPLICATE_CONFLICT` |
| 版番号不一致・対象なし                            | 409 `WELLNESS_CONFLICT`           |

アーカイブ済み種別でも**既存記録の更新は妨げない**（アーカイブ前の記録を後から直せる）。

---

## 6. 体調記録

### 6.1 `ConditionEntry` の応答形

```jsonc
{
  "id": "…",
  "recordedAt": "2026-09-02T08:00:00.000Z", // 時間軸
  "timezone": "Asia/Tokyo",
  "overallScore": 7, // 総合   0〜10。未入力は null
  "fatigueScore": 3, // 疲労   0〜10
  "energyScore": 6, // 活力   0〜10
  "stressScore": 2, // ストレス 0〜10
  "painScore": 0, // 痛み   0〜10
  "moodScore": 7, // 気分   0〜10
  "bodyTemperatureC": 36.6, // 体温 30〜45℃（小数1桁）。未入力は null
  "freeTextSymptoms": ["肩こり"], // 自由記述症状。10件まで
  "symptoms": [
    // 症状種別へのリンク。sortOrder → symptomKey 順
    {
      "id": "…", // リンク行のID（表示・key に使う。更新では送らない）
      "symptomTypeId": "…",
      "symptomKey": "headache",
      "displayName": "頭痛",
      "severity": 3, // 0〜10。未入力は null
      "note": null, // 200字
    },
  ],
  "note": null, // 500字
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-02T08:00:00.000Z",
  "updatedAt": "2026-09-02T08:00:00.000Z",
}
```

**症状には2つの入れ物がある**（実装仕様書 5.5節）。

| 入れ物             | 用途                                              | 上限                     |
| ------------------ | ------------------------------------------------- | ------------------------ |
| `symptoms`         | 種別として登録した症状（既定13種 + カスタム30件） | 1記録につき43件          |
| `freeTextSymptoms` | 種別にしない一過性の症状（文字列）                | 1記録につき10件、各100字 |

### 6.2 `POST` — 体調記録の保存

```jsonc
{
  "resource": "condition",
  "clientMutationId": "…", // 任意
  "entry": {
    "id": "…", // 省略 → 作成 / 指定 → 更新
    "expectedRowVersion": 2, // 更新のときは必須
    "recordedAt": "2026-09-02T08:00:00Z", // 必須
    "timezone": "Asia/Tokyo", // 任意（既定 Asia/Tokyo）
    "overallScore": 7, // 任意 0〜10（以下同じ）
    "fatigueScore": 3,
    "energyScore": 6,
    "stressScore": 2,
    "painScore": 0,
    "moodScore": 7,
    "bodyTemperatureC": 36.6, // 任意 30〜45、小数1桁
    "freeTextSymptoms": ["肩こり"], // 任意 10件まで、各1〜100字
    "symptoms": [
      // 任意。**送ると全置換**（6.3節）
      { "symptomTypeId": "…", "severity": 3, "note": "朝から" },
    ],
    "note": null, // 任意 500字
  },
}
```

応答 `201` / `200`:
`{ "data": { "resource": "condition", "entry": {…}, "outcome": … } }`

主な失敗:

| 状況                                  | 応答                              |
| ------------------------------------- | --------------------------------- |
| `symptomTypeId` が所有者の種別に無い  | 404 `WELLNESS_TYPE_NOT_FOUND`     |
| `symptomTypeId` がアーカイブ済み      | 400 `WELLNESS_TYPE_ARCHIVED`      |
| 同じ `symptomTypeId` を重複して送った | 400 `INVALID_REQUEST`             |
| 同じ記録日時の記録が既にある          | 409 `WELLNESS_DUPLICATE_CONFLICT` |
| 版番号不一致・対象なし                | 409 `WELLNESS_CONFLICT`           |

### 6.3 `symptoms` の扱い（**全置換**）

- `symptoms` を**送ると、その配列が症状リンクの全部になる**（差分ではない）。
  既存のリンクは消える。
- `symptoms: []` を送ると全解除。
- `symptoms` を**省略すると既存のリンクをそのまま残す**（1.6節の例外）。
  スコアだけ直したいときは省略すればよい。
- 置換は DB 側の1トランザクション（`replace_condition_entry_symptoms` RPC）で行うので、
  「古い症状だけ消えて新しい症状が入らない」中途半端な状態にはならない。

**再送（`idempotent_replay`）のときの症状の扱い**:

- 応答の**スカラー値（スコア・体温・メモ・`rowVersion`）は適用当時のスナップショット**。
- 応答の `symptoms` は**その記録の現在のリンク**。症状リンクは親とは別の操作なので、
  スナップショットには含まれていない。
- 再送で症状を貼り直すのは、**スナップショットが最新世代のときだけ**。
  「親は保存できたが症状の置換に失敗した」まま再送されたケースを救うためで、
  古い世代の再送では触らない（あとから入った症状を巻き戻さないため）。

---

## 7. 目標

実装仕様書 5.5節「目標: 睡眠・水分の目標量、対象曜日、目標就床・起床時刻、
開始日・終了日を設定できる」。

**制約は2つだけ**（期間の重なりは禁じない。「今日から新しい目標へ切り替える」を
書けるようにするため）。

- 開始日は所有者ごとに一意（同じ日から始まる目標を2つ持たない）
- **終了日の無い（＝現在有効な）目標は所有者ごとに1件**

どちらも違反すると 409 `WELLNESS_GOAL_CONFLICT`。
新しい目標を作るときは、先に既存の目標へ `endDate` を入れて締める。

### 7.1 `SleepGoal` の応答形

```jsonc
{
  "id": "…",
  "targetSleepMinutes": 420, // 目標量（分）60〜1440
  "weekdays": [0, 1, 2, 3, 4, 5, 6], // 対象曜日。0=日曜〜6=土曜（Date#getDay() と同じ）
  "targetBedtime": "23:30", // 目標就床時刻 HH:MM。未設定は null
  "targetWakeTime": "06:30", // 目標起床時刻 HH:MM。未設定は null
  "timezone": "Asia/Tokyo",
  "startDate": "2026-09-01", // date（日時ではない）
  "endDate": null, // null なら現在有効
  "note": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "…",
  "updatedAt": "…",
}
```

### 7.2 `HydrationGoal` の応答形

```jsonc
{
  "id": "…",
  "targetAmountMl": 2000, // 目標量（ml）0超20,000以下
  "weekdays": [0, 1, 2, 3, 4, 5, 6],
  "timezone": "Asia/Tokyo",
  "startDate": "2026-09-01",
  "endDate": null,
  "note": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "…",
  "updatedAt": "…",
}
```

水分の目標に就床・起床時刻は無い（睡眠固有のため）。

### 7.3 `POST` — 目標の保存

```jsonc
// 睡眠
{
  "resource": "sleep_goal",
  "clientMutationId": "…",  // 任意
  "goal": {
    "id": "…",                    // 省略 → 作成 / 指定 → 更新
    "expectedRowVersion": 1,      // 更新のときは必須
    "targetSleepMinutes": 420,    // 必須 60〜1440
    "weekdays": [1, 2, 3, 4, 5],  // 任意（既定 [0..6]）。0〜6・重複なし・1〜7件
    "targetBedtime": "23:30",     // 任意 HH:MM
    "targetWakeTime": "06:30",    // 任意 HH:MM
    "timezone": "Asia/Tokyo",     // 任意
    "startDate": "2026-09-01",    // 必須 YYYY-MM-DD
    "endDate": null,              // 任意。null なら「現在有効」
    "note": null,                 // 任意 500字
  },
}

// 水分（targetAmountMl と、就床/起床時刻が無いこと以外は同じ）
{
  "resource": "hydration_goal",
  "goal": { "targetAmountMl": 2000, "startDate": "2026-09-01" },
}
```

応答 `201` / `200`:
`{ "data": { "resource": "sleep_goal", "goal": {…}, "outcome": … } }`
（水分は `"resource": "hydration_goal"`、キーは同じく `goal`）

`endDate` が `startDate` より前なら 400 `INVALID_REQUEST`。

---

## 8. 種別の追加・アーカイブ

種別に **`DELETE` は無い**。無効化は `archived: true` で行う
（過去の記録・目標を守るため。実装仕様書 5.3節の方針を 5.5節へ適用）。

### 8.1 既定投入

```jsonc
// リクエスト
{ "resource": "seed_defaults" }

// 応答 200
{
  "data": {
    "resource": "seed_defaults",
    "beverageTypes": [/* 既定10種。形は 2.1節 */],
    "symptomTypes": [/* 既定13種。形は 2.2節 */],
    "outcome": "seeded",
  },
}
```

飲み物と症状の**両方**を1回で投入する。冪等なので、初回ログイン後や
オンボーディング完了時に一度呼べばよく、再度呼んでも重複しない。
`clientMutationId` は受け付けない（送ると 400）。

### 8.2 カスタム種別の追加

```jsonc
// 飲み物
{
  "resource": "beverage_type",
  "clientMutationId": "…",          // 任意
  "type": {
    "beverageKey": "hot_water",     // 作成時のみ必須。^[a-z][a-z0-9_]{1,49}$
    "displayName": "白湯",          // 必須 1〜100字
    "defaultUnit": "ml",            // 必須 ml | l | us_fl_oz
    "defaultAmount": 200,           // 任意。0超10,000以下
    "containsCaffeine": false,      // 任意（既定 false）
    "containsAlcohol": false,       // 任意（既定 false）
    "sortOrder": 1000,              // 任意 0〜100000（既定 1000）
  },
}

// 症状
{
  "resource": "symptom_type",
  "type": { "symptomKey": "eye_strain", "displayName": "目の疲れ", "sortOrder": 1000 },
}
```

応答 `201`（作成）/ `200`（更新・再送）:

```jsonc
{ "data": { "resource": "beverage_type", "type": {/* 2.1節 */}, "outcome": "created" } }
```

`isDefault` はクライアントから指定できない（送ると 400）。**既定種別
（`is_default = true`）を作れるのも変えられるのも seed RPC だけ**で、
`authenticated` ロールには `is_default` 列の INSERT/UPDATE 権限が無く、
DB のトリガーが seed 以外からの書き込みを拒否する（実装仕様書 5.5節・9.2節）。

失敗: 項目キー重複 → 409 `WELLNESS_TYPE_CONFLICT`、
既定カタログの予約キー → 400 `WELLNESS_TYPE_KEY_RESERVED`（2.3節）、
カスタム症状30件超 → 400 `WELLNESS_TYPE_LIMIT_REACHED`。

### 8.3 種別の更新・アーカイブ／解除

更新は `type.id` と `expectedRowVersion` を付ける。項目キーは送らない（2.3節）。

```jsonc
{
  "resource": "beverage_type",
  "clientMutationId": "…", // 任意
  "type": {
    "id": "…", // 必須
    "expectedRowVersion": 3, // 必須
    "displayName": "白湯", // 必須（表示名は毎回送る）
    "defaultUnit": "ml", // 必須
    "defaultAmount": 200, // 任意
    "archived": true, // 任意。true でアーカイブ、false で解除、省略で現状維持
  },
}
```

応答 `200`: `{ "data": { "resource": "beverage_type", "type": {…}, "outcome": "updated" } }`

- **既定種別（`isDefault: true`）は変更もアーカイブもできない**（400 `INVALID_REQUEST`）。
  既定カタログのラベルや単位を書き換えられると、記録の表示を偽装できてしまうため。
  画面では既定種別の編集UIを出さないこと。DB のトリガーも同じ形を拒否する。
- アーカイブしても**過去の記録は消えない**。一覧にはアーカイブ済みも含めて返るので、
  画面側は `archivedAt !== null` を入力候補から外し、履歴の表示には引き続き使う。
- アーカイブ済み種別への**新規登録**は 400 `WELLNESS_TYPE_ARCHIVED`。
  既存記録の更新は妨げない。
- 対象が所有者の種別に無ければ 404 `WELLNESS_TYPE_NOT_FOUND`、
  版番号不一致は 409 `WELLNESS_TYPE_CONFLICT`。

---

## 9. `DELETE /api/wellness` — 記録・目標の削除

```jsonc
{
  "resource": "sleep", // sleep | hydration | condition | sleep_goal | hydration_goal
  "id": "…",
  "expectedRowVersion": 4, // 任意
}
```

応答 `200`: `{ "data": { "resource": "sleep", "deletedId": "…" } }`

- `expectedRowVersion` を送ると版番号が一致する行だけを削除する。
- 0件（存在しない・版番号違い）は 409 `WELLNESS_CONFLICT`。
- `beverage_type` / `symptom_type` は削除できない（400。8.3節のアーカイブを使う）。
- `clientMutationId` は受け付けない（400）。

体調記録を削除すると、その記録の症状リンクも一緒に消える（DB の CASCADE）。

---

## 10. 計算のフロント側での再利用

`src/features/wellness/units.ts` はサーバー・DB と同じ定数・同じ規則を持つ。
保存前のプレビュー表示や単位切り替えUIで再利用すること。

| 関数・値                                               | 内容                                                   |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `calculateSleepMinutes(sleepAt, wakeAt, awakeMinutes)` | 実装仕様書 5.5節の睡眠時間（分）。DB の生成列と同じ式  |
| `calculateTimeInBedMinutes(bedAt, outOfBedAt)`         | 就床〜離床の分数。DB の生成列と同じ式                  |
| `calculateSleepEfficiency(sleepMinutes, timeInBed)`    | 睡眠効率（%、小数1桁）。**推定値であって診断ではない** |
| `findSleepChronologyViolations(input)`                 | 4.2節の順序・24時間・覚醒時間の判定                    |
| `normalizeHydrationAmount(amount, unit)`               | ml 正規化。DB の `amount_ml` 生成列と同じ規則          |
| `convertMillilitersTo(amountMl, unit)`                 | ml から入力単位へ戻す（単位セレクトの切り替え）        |
| `MILLILITERS_PER_UNIT`                                 | 単位 → ml 係数（5.3節の表そのもの）                    |
| `areWeekdaysValid(weekdays)`                           | 目標の対象曜日の判定（0〜6・重複なし・1〜7件）         |
| `SLEEP_KINDS` / `SLEEP_KIND_LABELS`                    | 睡眠種別と日本語ラベル                                 |
| `HYDRATION_UNITS` / `HYDRATION_UNIT_LABELS`            | 水分の単位と表示                                       |
| `WEEKDAYS` / `WEEKDAY_LABELS`                          | 曜日（0=日）と日本語1文字ラベル                        |
| `roundTo(value, digits)`                               | 二進小数の誤差に強い丸め                               |

既定カタログ側（`defaults.ts`）にも同じ用途の値がある。

| 値・関数                                                 | 内容                                     |
| -------------------------------------------------------- | ---------------------------------------- |
| `DEFAULT_BEVERAGE_TYPES` / `DEFAULT_SYMPTOM_TYPES`       | 既定カタログ（2.4節・2.5節の表）         |
| `DEFAULT_BEVERAGE_KEYS` / `DEFAULT_SYMPTOM_KEYS`         | 予約語の項目キー                         |
| `isDefaultBeverageKey(key)` / `isDefaultSymptomKey(key)` | カスタム種別の入力欄で予約キーを先に弾く |
| `CUSTOM_SYMPTOM_TYPE_MAX`                                | カスタム症状の上限（30）                 |
| `CONDITION_ENTRY_SYMPTOM_MAX`                            | 1記録に紐づく症状の上限（43）            |
| `CONDITION_FREE_TEXT_SYMPTOM_MAX`                        | 自由記述症状の上限（10）                 |

保存済みの記録については、**応答の `sleepMinutes` / `timeInBedMinutes` / `amountMl` を
そのまま使う**（DB の生成列が計算しており、クライアント側で再計算する必要はない）。

---

## 11. Phase 4-1a の範囲外（フロント実装時の前提）

- 睡眠・水分・体調の画面、グラフ、CSV出力UI（Kimi K2.7 Code 担当）
- 平均値算出・トレンド表示（実装仕様書 5.5節「表示」）はフロント側の責務。
  必要な列はすべて GET の応答に含まれる（3節）
- オフライン同期キュー本体（実装仕様書 8.1節）。ただし本APIは
  `clientMutationId` による再送の受け入れ側を既に備えている。
  何世代前のキーでも replay になるため（1.5節）、キューは順序を保って
  1件ずつ流す必要はない。再送のたびに新しい UUID を振らないことだけを守る
- 他の機能領域（サプリ、食事、運動など。Phase 4 の別サブフェーズ）

---

## 12. 健康上の安全（実装仕様書 5.5節 / 10章）

- **比較結果を因果関係として断定しない。** 「睡眠が短い→体調が悪い」のような
  文言を画面に出さないこと。並べて見せるところまでが本アプリの役割。
- 体温・症状は記録項目であって診断ではない。閾値による判定・受診勧奨の断定をしない。
- 睡眠効率などの算出値は**推定**であることを明示する。

---

## 13. 検証状況

| 対象                                                                                                           | テスト                                  |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| migration の新規適用、共通テンプレートの取り付け、制約、生成列、seed RPC、既定種別保護、冪等キーの適用結果ログ | `tests/db/wellness.test.ts`             |
| RLS 分離、匿名拒否、非active排除、複合外部キー、CASCADE、種別カタログの DELETE 不可                            | `tests/db/wellness-rls.test.ts`         |
| 何世代前の冪等キーでも同一の成功応答／同時多重送信／重複登録防止／**409 後の対象特定クエリ**                   | `tests/db/wellness-idempotency.test.ts` |
| 睡眠時間・水分正規化・睡眠効率・順序判定・曜日判定                                                             | `src/features/wellness/units.test.ts`   |
| 入力スキーマ（`.strict()`・値域・必須条件）                                                                    | `src/features/wellness/schema.test.ts`  |
| 共通境界・楽観ロック・冪等キー・重複防止・ページング・リソース分岐・種別保護                                   | `src/app/api/wellness/route.test.ts`    |
| 所有者フィールドの拒否                                                                                         | `src/server/api/owner-fields.test.ts`   |

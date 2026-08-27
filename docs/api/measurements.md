# 身体測定 API 契約（実装仕様書 5.3節 / 7章）

**Phase 3a（バックエンド）で確定した契約。** フロントエンド（`/measurements` 画面）は
本書と `src/features/body-measurements/schema.ts` を前提に実装する。

| 事項               | 内容                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| 型・スキーマの正本 | [`src/features/body-measurements/schema.ts`](../../src/features/body-measurements/schema.ts)     |
| 単位・換算・BMI    | [`src/features/body-measurements/units.ts`](../../src/features/body-measurements/units.ts)       |
| 既定種別カタログ   | [`src/features/body-measurements/defaults.ts`](../../src/features/body-measurements/defaults.ts) |
| DB スキーマ        | `supabase/migrations/20260827000500_body_measurements.sql` ほか2件                               |
| 共通のテーブル規約 | [`docs/database/table-conventions.md`](../database/table-conventions.md)                         |

`schema.ts` / `units.ts` / `defaults.ts` は**サーバー専用の依存を持たない**ため、
クライアントコンポーネントからそのまま import してよい。
`src/server/**` は import しないこと（`import "server-only"` によりビルドが落ちる）。

---

## 1. 共通事項

### 1.1 全エンドポイントに共通の境界（実装仕様書 7章）

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
await fetch("/api/measurements", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ clientMutationId, measurement }),
});
```

### 1.2 応答の形

成功は `{ "data": ... }`、失敗は `{ "error": { "code": ..., "message": ... } }`。
`message` は利用者へそのまま表示できる日本語で、入力値・健康データ・内部情報を含まない。

### 1.3 所有者IDを送ってはいけない（実装仕様書 3.2節）

`owner_id` / `ownerId` / `user_id` / `userId` / `owner` / `uid` / `sub` は
**ネストした位置も含めて** 400 で拒否される。行の主キー `id` は更新・削除で使うため
この対象ではない。

### 1.4 楽観ロック（実装仕様書 6.4節）

- 応答の各行は `rowVersion` を持つ。
- **更新するときは、直前に受け取った `rowVersion` を `expectedRowVersion` として送る。**
- 版番号が違う／行が消えている場合は **409**。
  行の不在と版番号違いは**区別されない**（他利用者の行の存在を漏らさないため）。
- 409 を受けたら、一覧を取り直して最新の `rowVersion` で再試行する。
- `rowVersion` はサーバーだけが進める。送っても保存には使われない（比較のみ）。

### 1.5 冪等キー（実装仕様書 6.4節 / 8.1節）

- 保存系（`POST`）は任意で `clientMutationId`（UUID v4）を受ける。
- **1つのミューテーションにつき1つの UUID を生成し、再送時も同じ値を使う。**
- 既に適用済みの `clientMutationId` なら、サーバーは新しい行を作らず
  **同じ成功応答**（`outcome: "idempotent_replay"`、HTTP 200）を返す。
- 別利用者が同じ UUID を使っても衝突しない（所有者ごとに閉じた一意制約）。
- 制限: 行の `clientMutationId` は最後のミューテーションの値で上書きされる。
  同じ行を続けて更新した場合、**2つ前**の再送は replay として検出されず 409 になる。
  オフラインキューは順序を保って1件ずつ流すこと。

### 1.6 エラーコード一覧

| コード                           | HTTP | 発生条件                                                                       | 画面での扱い                           |
| -------------------------------- | ---- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `SAME_ORIGIN_REQUIRED`           | 403  | `Origin` / `Sec-Fetch-Site` が同一オリジンでない                               | 実装バグ。相対URLで `fetch` する       |
| `AUTHENTICATION_REQUIRED`        | 401  | 検証済みセッションが無い                                                       | `/auth` へ誘導                         |
| `ACCOUNT_INACTIVE`               | 403  | `users.status` が `active` 以外                                                | 処理中の案内を出す（実装仕様書 5.1節） |
| `ACCOUNT_SERVICE_UNAVAILABLE`    | 503  | Supabase 未設定（実装仕様書 3.3節）                                            | デモモードへ誘導                       |
| `JSON_REQUIRED`                  | 415  | `Content-Type` が `application/json` でない                                    | 実装バグ                               |
| `PAYLOAD_TOO_LARGE`              | 413  | ボディが 64 KiB 超                                                             | 入力を分割する                         |
| `INVALID_REQUEST`                | 400  | JSON 不正／スキーマ不一致／未知フィールド／所有者IDの持ち込み／不正な `cursor` | `message` をフォームエラーとして表示   |
| `MEASUREMENT_UNIT_NOT_ALLOWED`   | 400  | 単位が測定種別の単位制約に合わない                                             | 単位セレクトを種別で絞る（下記2.2）    |
| `MEASUREMENT_TYPE_NOT_FOUND`     | 404  | `typeId` が所有者の測定種別に無い                                              | 種別一覧を取り直す                     |
| `MEASUREMENT_CONFLICT`           | 409  | 版番号不一致、または対象行が無い（更新・削除）                                 | 一覧を再取得して再試行                 |
| `MEASUREMENT_DUPLICATE_CONFLICT` | 409  | 同一の所有者・種別・日時の記録が既にある                                       | 日時を変えるか既存を編集               |
| `MEASUREMENT_TYPE_CONFLICT`      | 409  | 同じ項目キーの測定種別が既にある                                               | 別のキーを促す                         |
| `MEASUREMENT_GOAL_CONFLICT`      | 409  | 未達成の目標がその種別に既にある                                               | 既存の目標を更新するよう促す           |

コードの定義は [`src/server/api/errors.ts`](../../src/server/api/errors.ts) の `API_ERROR_CODES`。
将来コードが増えうるため、フロントは**未知のコードを `message` の表示で扱えるようにしておく**
（`apiErrorResponseSchema` の `code` は `z.string()`）。

---

## 2. 測定種別

### 2.1 既定10種別（実装仕様書 5.3節）

`POST /api/measurements/types` に `{"action":"seed_defaults"}` を送ると、
`seed_default_body_measurement_types` RPC が所有者の行として投入する。**何度呼んでも増えない。**

| `measurementKey`      | 表示名     | `unitConstraint` | `defaultUnit` | `sortOrder` |
| --------------------- | ---------- | ---------------- | ------------- | ----------- |
| `weight`              | 体重       | `mass`           | `kg`          | 10          |
| `body_fat_percentage` | 体脂肪率   | `percent`        | `percent`     | 20          |
| `bmi`                 | BMI        | `percent`        | `percent`     | 30          |
| `waist`               | ウエスト   | `length`         | `cm`          | 40          |
| `navel_girth`         | へそ周り   | `length`         | `cm`          | 50          |
| `pelvis_girth`        | 骨盤周り   | `length`         | `cm`          | 60          |
| `hip`                 | ヒップ     | `length`         | `cm`          | 70          |
| `thigh`               | 太もも     | `length`         | `cm`          | 80          |
| `calf`                | ふくらはぎ | `length`         | `cm`          | 90          |
| `shoulder_width`      | 肩幅       | `length`         | `cm`          | 100         |

TypeScript からは `DEFAULT_MEASUREMENT_TYPES`（`features/body-measurements/defaults.ts`）で
同じ内容を参照できる。DB のカタログとの一致は `tests/db/body-measurements.test.ts` が検証している。

> **BMI の単位制約が `percent` なのは実装仕様書 5.3節「体脂肪率・BMIは %」に従ったもの。**
> BMI は本来無次元だが、仕様書の記述を単一の正としている。

### 2.2 単位制約（実装仕様書 5.3節）

| `unitConstraint` | 使える `unit` | 対象                       |
| ---------------- | ------------- | -------------------------- |
| `mass`           | `kg` `lb`     | 体重                       |
| `percent`        | `percent`     | 体脂肪率、BMI              |
| `length`         | `cm` `inch`   | ウエスト等の周囲・長さ     |
| `custom`         | `custom`      | 単位を持たないカスタム項目 |

フロントは `isUnitAllowedFor(unitConstraint, unit)`（`units.ts`）で
単位セレクトを絞ること。合わない単位は 400 `MEASUREMENT_UNIT_NOT_ALLOWED` になる。

### 2.3 カスタム項目キー

`^[a-z][a-z0-9_]{1,49}$`（英小文字始まり、2〜50文字）。所有者ごとに一意。

---

## 3. `GET /api/measurements` — 測定記録の取得

### クエリパラメータ

| 名前             | 型           | 既定   | 内容                                                    |
| ---------------- | ------------ | ------ | ------------------------------------------------------- |
| `typeId`         | UUID         | —      | 測定種別で絞り込む                                      |
| `measurementKey` | 項目キー     | —      | 種別キーで絞り込む（`typeId` と併用可・両方一致が必要） |
| `from`           | ISO 8601     | —      | `measuredAt >= from`（オフセット必須）                  |
| `to`             | ISO 8601     | —      | `measuredAt <= to`（オフセット必須）                    |
| `order`          | `asc`/`desc` | `desc` | `measuredAt` の並び                                     |
| `limit`          | 整数 1〜500  | `100`  | 1ページの件数                                           |
| `cursor`         | 不透明文字列 | —      | 前ページの `data.page.nextCursor` をそのまま渡す        |

未知のパラメータは 400。存在しない `measurementKey` は**エラーにならず空一覧**を返す
（既定投入の前でも画面を描けるようにするため）。

### 応答 `200`

```jsonc
{
  "data": {
    "measurements": [
      {
        "id": "…",
        "typeId": "…",
        "measurementKey": "weight", // 種別を引き直さずにラベル・CSVを作れる
        "displayName": "体重",
        "measuredAt": "2026-08-27T07:30:00.000Z",
        "value": 62.4,
        "unit": "kg",
        "normalizedValue": 62.4, // 集計・グラフ・CSV用（実装仕様書 6.3節）
        "normalizedUnit": "kg", // mass→kg / length→cm / percent→percent / custom→null
        "note": null,
        "measurementCondition": null,
        "bodySite": null,
        "photoReference": null,
        "rowVersion": 1,
        "clientMutationId": null,
        "createdAt": "2026-08-27T07:31:00.000Z",
        "updatedAt": "2026-08-27T07:31:00.000Z",
      },
    ],
    "types": [/* 所有者の測定種別。アーカイブ済みも含む全件 */],
    "context": {
      "heightCm": 168, // 確定プロフィール由来。未確定なら null
      "latestWeightKg": 62.4, // 既定種別 weight の最新値（kg 正規化）
      "latestWeightMeasuredAt": "2026-08-27T07:30:00.000Z",
      "bmi": 22.1, // 小数1桁。身長か体重が無ければ null
    },
    "page": { "limit": 100, "order": "desc", "nextCursor": null },
  },
}
```

**測定種別の一覧取得は本エンドポイントの `data.types`** で行う
（`/api/measurements/types` に GET は無い）。画面の初期表示は
`GET /api/measurements` 1回で記録・種別・BMI文脈がすべて揃う。

### ページング方式（キーセット／カーソル）

オフセットではなく **`(measuredAt, id)` のキーセット方式**。追記が続く時系列でも
行の取りこぼし・重複が起きない。

1. 1ページ目は `cursor` を付けずに呼ぶ。
2. `data.page.nextCursor` が `null` でなければ次ページがある。
3. 次ページは同じ絞り込み条件に `cursor=<nextCursor>` を足して呼ぶ。
4. `nextCursor` が `null` になったら終端。

`cursor` は不透明な文字列。中身を組み立てたり書き換えたりしないこと（不正な値は 400）。
`order` / `limit` / 絞り込み条件はページ間で変えないこと。

### CSV 出力について

CSV に必要な列（`measuredAt` / `measurementKey` / `displayName` / `value` / `unit` /
`normalizedValue` / `normalizedUnit` / `note` / `measurementCondition` / `bodySite`）は
すべて本応答に含まれる。**別途 CSV 用のエンドポイントは無い**。
`nextCursor` が `null` になるまでページを辿って全件を集め、クライアント側で整形する。

> CSV を組み立てるときは、実装仕様書 9.2節の数式インジェクション対策
> （`=` `+` `-` `@` で始まる値へのクォート前置）を必ず適用すること。
> サーバー側の実装は `src/server/account/export.ts` の `escapeCsvValue()` にあるが、
> これはサーバー専用モジュールなので、フロントでは同等の処理を用意する。

---

## 4. `POST /api/measurements` — 測定記録の保存

作成と更新を兼ねる。`measurement.id` の有無で分岐する。

### リクエスト

```jsonc
{
  "clientMutationId": "…", // 任意。オフライン再送の冪等キー（1.5節）
  "measurement": {
    "id": "…", // 省略 → 作成 / 指定 → 更新
    "expectedRowVersion": 3, // 更新のときは必須、作成のときは送ってはいけない
    "typeId": "…", // 必須
    "measuredAt": "2026-08-27T07:30:00Z", // 必須。オフセット必須の ISO 8601
    "value": 62.4, // 必須。0 超 1000 以下、小数第3位まで
    "unit": "kg", // 必須。種別の単位制約に合うもの
    "note": null, // 任意。500字
    "measurementCondition": null, // 任意。200字
    "bodySite": null, // 任意。100字
    "photoReference": null, // 任意。5節を参照
  },
}
```

### 応答 `201`（作成）／ `200`（更新・再送）

```jsonc
{
  "data": {
    "measurement": { /* 3節と同じ形 */ },
    "outcome": "created" | "updated" | "idempotent_replay",
    "derivedBmi": 22.1   // 単位制約 mass の種別を保存し、確定プロフィールに身長がある場合のみ。他は null
  }
}
```

### 主な失敗

| 状況                                      | 応答                                 |
| ----------------------------------------- | ------------------------------------ |
| 版番号不一致・対象なし                    | 409 `MEASUREMENT_CONFLICT`           |
| 同じ種別・同じ日時の記録が既にある        | 409 `MEASUREMENT_DUPLICATE_CONFLICT` |
| `typeId` が所有者の種別に無い             | 404 `MEASUREMENT_TYPE_NOT_FOUND`     |
| 単位が種別の制約に合わない                | 400 `MEASUREMENT_UNIT_NOT_ALLOWED`   |
| `id` があるのに `expectedRowVersion` 無し | 400 `INVALID_REQUEST`                |

---

## 5. 写真参照（`photoReference`）

実装仕様書 5.3節により、次の2つの形だけが保存できる。

1. **HTTPS URL**（`https://…`）
2. **`storage://health-images/<所有者UUID>/<オブジェクトパス>`**

`<所有者UUID>` は実装仕様書 6.6節のオブジェクトパス `<auth.uid()>/<random-uuid>.<拡張子>` の
先頭セグメント。**自分以外のUUIDを指すと 400**（サーバー検査とDBの CHECK 制約の両方で拒否）。

`http://` / `javascript:` / 他バケット（`food-images-private`）は拒否される。
画像のアップロード API と署名URLの発行は Phase 3a の範囲外（実装仕様書 6.6節・9.2節）。
現時点で `storage://` 参照を作れるのは、後続フェーズでアップロード API が入ってから。

---

## 6. `POST /api/measurements/types` — 測定種別

GET は無い（種別一覧は `GET /api/measurements` の `data.types`）。
DELETE も無い。**無効化は `archived_at` の更新で行う**（既定種別はアーカイブ不可）。

### 6.1 既定投入

```jsonc
// リクエスト
{ "action": "seed_defaults" }

// 応答 200
{ "data": { "types": [ /* 既定10種別 */ ], "outcome": "seeded" } }
```

冪等。初回ログイン後やオンボーディング完了時に一度呼べばよく、
再度呼んでも重複しない。

### 6.2 カスタム種別の追加

```jsonc
// リクエスト
{
  "action": "create",
  "clientMutationId": "…",          // 任意
  "type": {
    "measurementKey": "grip_strength",  // ^[a-z][a-z0-9_]{1,49}$
    "displayName": "握力",              // 1〜100字
    "unitConstraint": "custom",         // mass | percent | length | custom
    "defaultUnit": "custom",            // unitConstraint に合うもの
    "sortOrder": 1000                   // 任意。0〜100000（既定 1000）
  }
}

// 応答 201（作成）/ 200（再送）
{ "data": { "types": [ /* 追加した1件 */ ], "outcome": "created" | "idempotent_replay" } }
```

`isDefault` はクライアントから指定できない（送ると 400）。
`is_default` を名乗れるのは既定カタログのキーだけで、DB のトリガーが強制する。

失敗: 項目キー重複 → 409 `MEASUREMENT_TYPE_CONFLICT`、
既定単位が制約に合わない → 400 `MEASUREMENT_UNIT_NOT_ALLOWED`。

---

## 7. `/api/measurements/goals` — 測定目標

グラフの目標線に使う。**未達成（`achievedAt: null`）の目標は測定種別ごとに1件まで。**

### 7.1 `GET`

| クエリ            | 型                 | 既定      | 内容                   |
| ----------------- | ------------------ | --------- | ---------------------- |
| `typeId`          | UUID               | —         | 測定種別で絞り込む     |
| `includeAchieved` | `"true"`/`"false"` | `"false"` | 達成済みの目標も含める |

```jsonc
{
  "data": {
    "goals": [
      {
        "id": "…",
        "typeId": "…",
        "measurementKey": "weight",
        "displayName": "体重",
        "targetValue": 60,
        "unit": "kg",
        "startValue": 64,
        "targetDate": "2026-12-31", // date（日時ではない）。任意
        "note": null,
        "achievedAt": null,
        "rowVersion": 1,
        "clientMutationId": null,
        "createdAt": "…",
        "updatedAt": "…",
      },
    ],
  },
}
```

### 7.2 `POST`

```jsonc
{
  "clientMutationId": "…", // 任意
  "goal": {
    "id": "…", // 省略 → 作成 / 指定 → 更新
    "expectedRowVersion": 1, // 更新のときは必須
    "typeId": "…", // 必須
    "targetValue": 60, // 必須。0 超 1000 以下
    "unit": "kg", // 必須。種別の単位制約に合うもの
    "startValue": 64, // 任意
    "targetDate": "2026-12-31", // 任意。YYYY-MM-DD
    "note": null, // 任意。500字
    "achievedAt": null, // 任意。設定すると「未達成は1件」の制約から外れる
  },
}
```

応答 `201`/`200`: `{ "data": { "goal": { … }, "outcome": "created" | "updated" | "idempotent_replay" } }`

同じ種別に未達成の目標が既にあると 409 `MEASUREMENT_GOAL_CONFLICT`。
既存の目標を更新するか、`achievedAt` を設定して締めてから新しい目標を作る。

### 7.3 `DELETE`

```jsonc
{ "goalId": "…", "expectedRowVersion": 2 } // expectedRowVersion は任意
```

応答 `200`: `{ "data": { "deletedId": "…" } }`
0件削除は 409 `MEASUREMENT_CONFLICT`。

---

## 8. `DELETE /api/measurements` — 測定記録の削除

```jsonc
{ "measurementId": "…", "expectedRowVersion": 4 } // expectedRowVersion は任意
```

応答 `200`: `{ "data": { "deletedId": "…" } }`

`expectedRowVersion` を送ると版番号が一致する行だけを削除する。
0件（存在しない・版番号違い）は 409 `MEASUREMENT_CONFLICT`。

---

## 9. 計算のフロント側での再利用

`src/features/body-measurements/units.ts` はサーバーと同じ定数・同じ規則を持つ。
保存前のプレビュー表示や単位切り替えUIで再利用すること。

| 関数                                          | 内容                                               |
| --------------------------------------------- | -------------------------------------------------- |
| `calculateBmi(weightKg, heightCm)`            | 実装仕様書 5.3節の BMI（小数1桁）。不能なら `null` |
| `poundsToKilograms` / `kilogramsToPounds`     | `0.45359237`                                       |
| `inchesToCentimeters` / `centimetersToInches` | `2.54`                                             |
| `normalizeMeasurement(value, unit)`           | 集計用の正規化。`custom` は `null`                 |
| `isUnitAllowedFor(constraint, unit)`          | 単位制約の判定                                     |
| `roundTo(value, digits)`                      | 二進小数の誤差に強い丸め                           |

保存済みの記録については、**応答の `normalizedValue` / `normalizedUnit` をそのまま使う**
（DB の生成列が計算しており、クライアント側で再計算する必要はない）。

---

## 10. Phase 3a の範囲外（フロント実装時の前提）

- `/measurements` 画面、グラフ、CSV出力UI（Kimi K2.7 Code 担当）
- 画像アップロードAPIと署名URL発行（実装仕様書 6.6節・9.2節。後続フェーズ）
- `progress_photos` テーブル（実装仕様書 6.1節。後続フェーズ）
- オフライン同期キュー本体（実装仕様書 8.1節）。ただし本APIは
  `clientMutationId` による再送の受け入れ側を既に備えている
- 移動平均などのトレンド計算（実装仕様書 5.3節「表示」）はフロント側の責務

---

## 11. 検証状況

| 対象                                                       | テスト                                          |
| ---------------------------------------------------------- | ----------------------------------------------- |
| migration の新規適用、制約、生成列、seed RPC、既定種別保護 | `tests/db/body-measurements.test.ts`            |
| RLS 分離、匿名拒否、非active排除、CASCADE                  | `tests/db/body-measurements-rls.test.ts`        |
| BMI・単位換算・単位制約                                    | `src/features/body-measurements/units.test.ts`  |
| 入力スキーマ（`.strict()`・値域・写真参照）                | `src/features/body-measurements/schema.test.ts` |
| 共通境界・楽観ロック・冪等キー・重複防止・ページング       | `src/app/api/measurements/**/route.test.ts`     |
| 確定プロフィールからの身長読み出し                         | `src/server/body-measurements/bmi.test.ts`      |
| カーソルの往復・改竄検出                                   | `src/server/body-measurements/cursor.test.ts`   |
| 所有者フィールドの拒否                                     | `src/server/api/owner-fields.test.ts`           |

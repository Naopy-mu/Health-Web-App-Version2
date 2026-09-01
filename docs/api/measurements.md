# 身体測定 API 契約（実装仕様書 5.3節 / 7章）

**Phase 3a（バックエンド）で確定した契約。** フロントエンド（`/measurements` 画面）は
本書と `src/features/body-measurements/schema.ts` を前提に実装する。

| 事項               | 内容                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| 型・スキーマの正本 | [`src/features/body-measurements/schema.ts`](../../src/features/body-measurements/schema.ts)     |
| 単位・換算・BMI    | [`src/features/body-measurements/units.ts`](../../src/features/body-measurements/units.ts)       |
| 既定種別カタログ   | [`src/features/body-measurements/defaults.ts`](../../src/features/body-measurements/defaults.ts) |
| DB スキーマ        | `supabase/migrations/20260827000500_body_measurements.sql` ほか3件                               |
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
| `Content-Type`   | POST / PATCH / DELETE は `application/json` 必須（無い・違う → 415）       |
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

- 保存系（`POST` / `PATCH`）は任意で `clientMutationId`（UUID v4）を受ける。
- **1つのミューテーションにつき1つの UUID を生成し、再送時も同じ値を使う。**
- 既に適用済みの `clientMutationId` なら、サーバーは新しい行を作らず
  **同じ成功応答**（`outcome: "idempotent_replay"`、HTTP 200）を返す。
- 別利用者が同じ UUID を使っても衝突しない（所有者ごとに閉じた一意制約）。
  種別・記録・目標の3リソース間でも独立しているので、同じ UUID を
  別リソースへ使っても replay にはならない。
- **何世代前の再送でも成功応答になる。** 同じ行を `A → B → C` と続けて更新したあとに
  `A` で再送しても 409 にはならず、**`A` が当時返したのと同じ応答**が返る。
  サーバーは適用結果を `body_measurement_mutation_log` に履歴として持ち、
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
> 最新の状態が必要なら `GET /api/measurements` を取り直す。
> replay 応答は「失われた応答の再受信」であり、行の現在値の問い合わせではない。

- 冪等キーを付けられるのは**作成・更新**のみ。`DELETE` は `clientMutationId` を
  受け付けない（削除は 0 件なら 409。既に消えている行の再送はエラーになる）。

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
| `MEASUREMENT_TYPE_ARCHIVED`      | 400  | アーカイブ済みの種別へ新規の記録・目標を登録しようとした                       | アーカイブ解除を促す（下記6.3）        |
| `MEASUREMENT_TYPE_KEY_RESERVED`  | 400  | 既定カタログの項目キーをカスタム種別に使おうとした                             | 別のキーを促す（下記2.3）              |
| `MEASUREMENT_CONFLICT`           | 409  | 測定記録・測定目標の版番号不一致、または対象行が無い（更新・削除）             | 一覧を再取得して再試行                 |
| `MEASUREMENT_DUPLICATE_CONFLICT` | 409  | 同一の所有者・種別・日時の記録が既にある                                       | 日時を変えるか既存を編集               |
| `MEASUREMENT_TYPE_CONFLICT`      | 409  | 同じ項目キーの測定種別が既にある／種別の PATCH で版番号不一致・対象なし        | 別のキーを促す／一覧を再取得           |
| `MEASUREMENT_GOAL_CONFLICT`      | 409  | 未達成の目標がその種別に既にある                                               | 既存の目標を更新するよう促す           |

上表は**身体測定APIから返りうるコードの全部**。`API_ERROR_CODES` にはこのほか
`REAUTHENTICATION_REQUIRED`（5.1節の再認証）と `NOT_IMPLEMENTED` があるが、
本APIの経路からは返らない。

コードの定義は [`src/server/api/errors.ts`](../../src/server/api/errors.ts) の `API_ERROR_CODES`。
将来コードが増えうるため、フロントは**未知のコードを `message` の表示で扱えるようにしておく**
（`apiErrorResponseSchema` の `code` は `z.string()`）。

---

## 2. 測定種別

### 2.0 `MeasurementType` の応答形

測定種別を返すすべての場所（`GET /api/measurements` の `data.types`、
`POST /api/measurements/types` の `data.types`、
`PATCH /api/measurements/types/{id}` の `data.type`）で**同じ形**。
正本は `schema.ts` の `measurementTypeSchema`。

```jsonc
{
  "id": "7e2d3c4b-5a69-4788-9900-aabbccddeeff", // UUID。更新・記録の typeId に使う
  "measurementKey": "weight", // 項目キー。既定10種は2.1節の表、カスタムは 2.3節の形
  "displayName": "体重", // 1〜100字
  "unitConstraint": "mass", // "mass" | "percent" | "index" | "length" | "custom"（2.2節）
  "defaultUnit": "kg", // unitConstraint が許す単位のひとつ。入力欄の初期値に使う
  "isDefault": true, // 既定カタログ由来なら true。クライアントからは指定・変更できない
  "sortOrder": 10, // 0〜100000。一覧の並び順（同値なら measurementKey 順）
  "archivedAt": null, // アーカイブ日時（ISO 8601、UTC の "Z" 表記）。有効な種別は null
  "rowVersion": 1, // 楽観ロックの版番号（1.4節）
  "clientMutationId": null, // その行を最後に変更したミューテーションの冪等キー（1.5節）
  "createdAt": "2026-08-27T00:00:00.000Z",
  "updatedAt": "2026-08-27T00:00:00.000Z",
}
```

全フィールド必須（省略されない）。`null` になりうるのは `archivedAt` と
`clientMutationId` だけ。日時はすべて `Z` 付きの ISO 8601 で返る。

一覧（`data.types`）は **`sortOrder` 昇順 → `measurementKey` 昇順**で、
**アーカイブ済みも含めた全件**。画面側は `archivedAt !== null` を入力候補から外し、
履歴の表示には引き続き使う（6.3節）。

### 2.1 既定10種別（実装仕様書 5.3節）

`POST /api/measurements/types` に `{"action":"seed_defaults"}` を送ると、
`seed_default_body_measurement_types` RPC が所有者の行として投入する。**何度呼んでも増えない。**

| `measurementKey`      | 表示名     | `unitConstraint` | `defaultUnit` | `sortOrder` |
| --------------------- | ---------- | ---------------- | ------------- | ----------- |
| `weight`              | 体重       | `mass`           | `kg`          | 10          |
| `body_fat_percentage` | 体脂肪率   | `percent`        | `percent`     | 20          |
| `bmi`                 | BMI        | `index`          | `index`       | 30          |
| `waist`               | ウエスト   | `length`         | `cm`          | 40          |
| `navel_girth`         | へそ周り   | `length`         | `cm`          | 50          |
| `pelvis_girth`        | 骨盤周り   | `length`         | `cm`          | 60          |
| `hip`                 | ヒップ     | `length`         | `cm`          | 70          |
| `thigh`               | 太もも     | `length`         | `cm`          | 80          |
| `calf`                | ふくらはぎ | `length`         | `cm`          | 90          |
| `shoulder_width`      | 肩幅       | `length`         | `cm`          | 100         |

TypeScript からは `DEFAULT_MEASUREMENT_TYPES`（`features/body-measurements/defaults.ts`）で
同じ内容を参照できる。DB のカタログとの一致は `tests/db/body-measurements.test.ts` が検証している。

> **BMI の単位制約は `index`（無次元）。** 実装仕様書 5.3節:
> 「BMIは無次元のため `index`」「**BMIを`percent`として扱わない**（BMIは割合ではないため、
> `%`表示は誤表示になる）」。画面でも BMI に `%` を付けないこと。

### 2.2 単位制約（実装仕様書 5.3節）

| `unitConstraint` | 使える `unit` | 対象                        |
| ---------------- | ------------- | --------------------------- |
| `mass`           | `kg` `lb`     | 体重                        |
| `percent`        | `percent`     | 体脂肪率                    |
| `index`          | `index`       | BMI（無次元。単位記号なし） |
| `length`         | `cm` `inch`   | ウエスト等の周囲・長さ      |
| `custom`         | `custom`      | 単位を持たないカスタム項目  |

**この5つがすべて**で、カスタム種別も同じ5つから選ぶ（6.2節）。
`index` は BMI 専用ではなく、**無次元の指標を測るカスタム種別でも選べる**
（例: 独自スコア）。予約されているのは `bmi` という**項目キー**だけで、
単位制約 `index` そのものは予約語ではない（2.3節）。

`unit` として `custom` を選ぶと `normalizedValue` / `normalizedUnit` が `null` になり、
集計・グラフの正規化対象から外れる（3節）。単位換算のいらない指標を残したい場合は
`custom` ではなく `index` を選ぶこと。

フロントは `isUnitAllowedFor(unitConstraint, unit)`（`units.ts`）で
単位セレクトを絞ること。合わない単位は 400 `MEASUREMENT_UNIT_NOT_ALLOWED` になる。
`UNITS_BY_CONSTRAINT`（同じく `units.ts`）に上の表がそのまま入っている。

### 2.3 カスタム項目キー

`^[a-z][a-z0-9_]{1,49}$`（英小文字始まり、2〜50文字）。所有者ごとに一意。

**既定カタログの10キー（2.1節の表）は予約語**で、カスタム種別には使えない
（400 `MEASUREMENT_TYPE_KEY_RESERVED`）。これを許すと、先に同じキーのカスタム種別を
作っておくことで既定種別になりすませてしまう（BMI の算出元の偽装など）。
DB のトリガーも同じ形を拒否する。

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

未知のパラメータは 400。値の形が不正なもの（UUIDでない `typeId`、オフセットの無い日時、
範囲外の `limit`、2.3節の形に合わない `measurementKey`）も 400。
形は正しいが**存在しない** `measurementKey` は、エラーにならず**空一覧**を返す
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
        "normalizedUnit": "kg", // mass→kg / length→cm / percent→percent / index→index / custom→null
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
    "types": [/* 所有者の測定種別。アーカイブ済みも含む全件。形は 2.0節 */],
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
    "derivedBmi": 22.1   // 既定の体重種別（isDefault:true かつ measurementKey:"weight"）を保存し、確定プロフィールに身長がある場合のみ。他は null
  }
}
```

`derivedBmi` は**既定の体重種別からのみ**算出する（実装仕様書 5.3節）。
利用者が自分で作った `kg`/`lb` 種別（例: 荷物の重さ）を保存しても `null` になる。

### 主な失敗

| 状況                                      | 応答                                 |
| ----------------------------------------- | ------------------------------------ |
| 版番号不一致・対象なし                    | 409 `MEASUREMENT_CONFLICT`           |
| 同じ種別・同じ日時の記録が既にある        | 409 `MEASUREMENT_DUPLICATE_CONFLICT` |
| `typeId` が所有者の種別に無い             | 404 `MEASUREMENT_TYPE_NOT_FOUND`     |
| `typeId` がアーカイブ済み（新規作成のみ） | 400 `MEASUREMENT_TYPE_ARCHIVED`      |
| 単位が種別の制約に合わない                | 400 `MEASUREMENT_UNIT_NOT_ALLOWED`   |
| `id` があるのに `expectedRowVersion` 無し | 400 `INVALID_REQUEST`                |
| `id` が無いのに `expectedRowVersion` あり | 400 `INVALID_REQUEST`                |
| `photoReference` が他人のストレージパス   | 400 `INVALID_REQUEST`                |

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

## 6. `/api/measurements/types` — 測定種別

GET は無い（種別一覧は `GET /api/measurements` の `data.types`）。
DELETE も無い。**無効化は `PATCH /api/measurements/types/{id}` のアーカイブで行う**
（6.3節。既定種別はアーカイブ不可）。

### 6.1 既定投入

```jsonc
// リクエスト
{ "action": "seed_defaults" }

// 応答 200
{ "data": { "types": [ /* 既定10種別。形は 2.0節 */ ], "outcome": "seeded" } }
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
    "unitConstraint": "custom",         // mass | percent | index | length | custom
    "defaultUnit": "custom",            // unitConstraint に合うもの（2.2節）
    "sortOrder": 1000                   // 任意。0〜100000（既定 1000）
  }
}

// 応答 201（作成）/ 200（再送）
{ "data": { "types": [ /* 追加した1件。2.0節の形 */ ], "outcome": "created" | "idempotent_replay" } }
```

`unitConstraint` は既定種別と同じ5つから選べる（2.2節）。`index` も選択可能で、
BMI 専用ではない。`isDefault` は常に `false` で返る。`sortOrder` を省略すると
`1000`（既定10種の 10〜100 より後ろ）になる。

`isDefault` はクライアントから指定できない（送ると 400）。**既定種別
（`is_default = true`）を作れるのも変えられるのも `seed_default_body_measurement_types`
RPC だけ**で、`authenticated` ロールには `is_default` 列の INSERT/UPDATE 権限が無く、
DB のトリガーが RPC 以外からの書き込みを拒否する（実装仕様書 5.3節・9.2節）。

既定種別の行は**表示名・既定単位・並び順の変更も含めて UPDATE 自体を拒否する**。
supabase-js で直接書いても同じ（DB トリガーが 42501 で落とす）。既定カタログの
ラベルや単位を書き換えられると、BMI やグラフの表示を偽装できてしまうため。
画面では既定種別の編集UIを出さないこと。

失敗: 項目キー重複 → 409 `MEASUREMENT_TYPE_CONFLICT`、
既定カタログの予約キー → 400 `MEASUREMENT_TYPE_KEY_RESERVED`（2.3節）、
既定単位が制約に合わない → 400 `MEASUREMENT_UNIT_NOT_ALLOWED`。

### 6.3 `PATCH /api/measurements/types/{id}` — アーカイブ／解除

実装仕様書 5.3節:

> カスタム種別は**アーカイブ（`archived_at`）による無効化**のみを許可し、
> 削除（DELETE）は提供しない（既存の測定記録・目標を保護するため）。
> 既定種別はアーカイブも不可とする。アーカイブ済み種別に対する新規の
> 測定記録・目標登録は拒否する。

`Content-Type: application/json` が必須（1.1節）。`{id}` は UUID で、形が違えば
400 `INVALID_REQUEST`。ボディは `.strict()` で、下記3つ以外のフィールドは 400。

```jsonc
// リクエスト
{
  "clientMutationId": "…", // 任意。再送の冪等キー（1.5節）
  "expectedRowVersion": 1, // 必須。楽観ロック（1.4節）
  "archived": true, // 必須。true でアーカイブ、false で解除
}
```

```jsonc
// 応答 200（アーカイブ / 解除 / 再送のいずれも 200。201 は返らない）
{
  "data": {
    "type": {
      "id": "7e2d3c4b-5a69-4788-9900-aabbccddeeff",
      "measurementKey": "grip_strength",
      "displayName": "握力",
      "unitConstraint": "custom",
      "defaultUnit": "custom",
      "isDefault": false, // 既定種別はここへ来ない（下の表のとおり 400）
      "sortOrder": 1000,
      "archivedAt": "2026-08-27T09:00:00.000Z", // archived:false での解除なら null
      "rowVersion": 2, // サーバーが +1 した値。次の更新にはこれを送る
      "clientMutationId": "…", // 送った冪等キー。省略時は null
      "createdAt": "2026-08-27T00:00:00.000Z",
      "updatedAt": "2026-08-27T09:00:00.000Z",
    },
    "outcome": "updated", // "updated" | "idempotent_replay"（"created" は返らない）
  },
}
```

`data.type` は 2.0節の `MeasurementType` と同じ形で、フィールドの欠けは無い。
`outcome: "idempotent_replay"` のときの `type` は**その冪等キーを適用した当時の
スナップショット**で、現在の行ではない（1.5節の注意書き）。

アーカイブしても**過去の測定記録・目標は消えない**。一覧（`GET /api/measurements` の
`data.types`）にはアーカイブ済みも含めて返るので、画面側は `archivedAt !== null` を
入力候補から外し、履歴の表示には引き続き使うこと。

| 状況                             | 応答                             |
| -------------------------------- | -------------------------------- |
| 既定種別をアーカイブしようとした | 400 `INVALID_REQUEST`            |
| `id` が所有者の種別に無い        | 404 `MEASUREMENT_TYPE_NOT_FOUND` |
| 版番号不一致・対象なし           | 409 `MEASUREMENT_TYPE_CONFLICT`  |

アーカイブ済み種別へ新規の測定記録・目標を登録しようとすると
400 `MEASUREMENT_TYPE_ARCHIVED`。**既存の記録の更新は妨げない**
（アーカイブ前に記録した値を後から直せる）。

---

## 7. `/api/measurements/goals` — 測定目標

グラフの目標線に使う。**未達成（`achievedAt: null`）の目標は測定種別ごとに1件まで。**

### 7.1 `GET`

| クエリ            | 型                 | 既定      | 内容                   |
| ----------------- | ------------------ | --------- | ---------------------- |
| `typeId`          | UUID               | —         | 測定種別で絞り込む     |
| `includeAchieved` | `"true"`/`"false"` | `"false"` | 達成済みの目標も含める |

並びは `createdAt` の降順（新しい順）。応答の1件は次の形で、全フィールドが必ず入る
（`null` になりうるのは `startValue` / `targetDate` / `note` / `achievedAt` /
`clientMutationId`）。正本は `schema.ts` の `measurementGoalSchema`。

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

同じ種別に未達成の目標が既にあると 409 `MEASUREMENT_GOAL_CONFLICT`
（実装仕様書 5.3節「未達成の目標は種別ごとに最大1件」）。
既存の目標を更新するか、`achievedAt` を設定して締めてから新しい目標を作る。

アーカイブ済み種別への新規の目標登録は 400 `MEASUREMENT_TYPE_ARCHIVED`（6.3節）。

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

| 関数                                          | 内容                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| `calculateBmi(weightKg, heightCm)`            | 実装仕様書 5.3節の BMI（小数1桁）。不能なら `null`   |
| `poundsToKilograms` / `kilogramsToPounds`     | `0.45359237`                                         |
| `inchesToCentimeters` / `centimetersToInches` | `2.54`                                               |
| `normalizeMeasurement(value, unit)`           | 集計用の正規化。`index` は素通し、`custom` は `null` |
| `isUnitAllowedFor(constraint, unit)`          | 単位制約の判定                                       |
| `UNITS_BY_CONSTRAINT`                         | 単位制約 → 使える単位の対応表（2.2節の表そのもの）   |
| `roundTo(value, digits)`                      | 二進小数の誤差に強い丸め                             |

既定カタログ側（`defaults.ts`）にも同じ用途の値がある。

| 値・関数                                         | 内容                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| `DEFAULT_MEASUREMENT_TYPES`                      | 既定10種別（2.1節の表）。表示順・単位制約つき            |
| `DEFAULT_MEASUREMENT_KEYS`                       | 既定10種の項目キー（2.3節の予約語）                      |
| `isDefaultMeasurementKey(key)`                   | カスタム種別の入力欄で予約キーを先に弾くのに使う         |
| `WEIGHT_MEASUREMENT_KEY` / `BMI_MEASUREMENT_KEY` | `"weight"` / `"bmi"`                                     |
| `isDefaultWeightType(type)`                      | `derivedBmi` の算出対象（既定の体重種別）かどうか（4節） |

保存済みの記録については、**応答の `normalizedValue` / `normalizedUnit` をそのまま使う**
（DB の生成列が計算しており、クライアント側で再計算する必要はない）。

---

## 10. Phase 3a の範囲外（フロント実装時の前提）

- `/measurements` 画面、グラフ、CSV出力UI（Kimi K2.7 Code 担当）
- 画像アップロードAPIと署名URL発行（実装仕様書 6.6節・9.2節。後続フェーズ）
- `progress_photos` テーブル（実装仕様書 6.1節。後続フェーズ）
- オフライン同期キュー本体（実装仕様書 8.1節）。ただし本APIは
  `clientMutationId` による再送の受け入れ側を既に備えている。
  何世代前のキーでも replay になるため（1.5節）、キューは順序を保って
  1件ずつ流す必要はない。再送のたびに新しい UUID を振らないことだけを守る
- 移動平均などのトレンド計算（実装仕様書 5.3節「表示」）はフロント側の責務

---

## 11. 検証状況

| 対象                                                                                                  | テスト                                          |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| migration の新規適用、制約、生成列、seed RPC、既定種別保護、冪等キーの適用結果ログ                    | `tests/db/body-measurements.test.ts`            |
| RLS 分離、匿名拒否、非active排除、CASCADE、既定種別の偽装・改ざん拒否、アーカイブ済み種別への登録拒否 | `tests/db/body-measurements-rls.test.ts`        |
| 何世代前の冪等キーでも同一の成功応答になること（実DB + 実リポジトリ）                                 | `tests/db/body-measurement-idempotency.test.ts` |
| BMI・単位換算・単位制約                                                                               | `src/features/body-measurements/units.test.ts`  |
| 入力スキーマ（`.strict()`・値域・写真参照）                                                           | `src/features/body-measurements/schema.test.ts` |
| 共通境界・楽観ロック・冪等キー（同時多重送信を含む）・重複防止・ページング・アーカイブ                | `src/app/api/measurements/**/route.test.ts`     |
| 確定プロフィールからの身長読み出し                                                                    | `src/server/body-measurements/bmi.test.ts`      |
| カーソルの往復・形式検証                                                                              | `src/server/body-measurements/cursor.test.ts`   |
| 所有者フィールドの拒否                                                                                | `src/server/api/owner-fields.test.ts`           |

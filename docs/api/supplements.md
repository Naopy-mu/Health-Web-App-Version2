# サプリメント API 契約（実装仕様書 5.6節 / 7章）

**Phase 4-2a（バックエンド）で確定した契約。** フロントエンド（サプリメント画面）は
本書と `src/features/supplements/schema.ts` を前提に実装する。

| 事項                     | 内容                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| 型・スキーマの正本       | [`src/features/supplements/schema.ts`](../../src/features/supplements/schema.ts)     |
| 列挙値・在庫計算・FEFO順 | [`src/features/supplements/units.ts`](../../src/features/supplements/units.ts)       |
| 409 後の対象特定ヘルパー | [`src/features/supplements/conflict.ts`](../../src/features/supplements/conflict.ts) |
| DB スキーマ              | `supabase/migrations/20260915000100_supplements_core.sql` ほか5件                    |
| 原子的RPC（FEFO・取消）  | `supabase/migrations/20260915000400_supplements_intake.sql`                          |
| 共通のテーブル規約       | [`docs/database/table-conventions.md`](../database/table-conventions.md)             |
| 同じ設計の先行実装       | [`docs/api/wellness.md`](./wellness.md)（睡眠・水分・体調。Phase 4-1a）              |

`schema.ts` / `units.ts` / `conflict.ts` は**サーバー専用の依存を持たない**ため、
クライアントコンポーネントからそのまま import してよい。
`src/server/**` は import しないこと（`import "server-only"` によりビルドが落ちる）。

エンドポイントは **`/api/supplements` の1本**だけ。商品・予定・服用・在庫のすべてを
`resource` で切り替える（実装仕様書 7章の表）。

> **この機能で一番気をつけるところ。**
> サプリメントは他の記録系と違い、**記録が在庫を動かす**。だから
>
> - 服用の記録・取消は**テーブルへ直接書けない**（原子的RPC経由のみ。1.5節）
> - 在庫が足りない服用は **409 で拒否される**（4.4節）
> - 取消は**消費したロットへ正確に戻す**（5.3節）
>
> 画面は「送信したら必ず記録できる」前提で作らないこと。**在庫不足は正常な結果**で、
> フォームのバリデーションでは防ぎきれない（送信までの間に別端末が消費しうる）。

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
await fetch("/api/supplements", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ resource: "intake", clientMutationId, intake }),
});
```

### 1.2 応答の形

成功は `{ "data": ... }`、失敗は `{ "error": { "code": ..., "message": ... } }`。
`message` は利用者へそのまま表示できる日本語で、入力値・健康データ・内部情報を含まない。

**成功応答の `data` は必ず `resource` を持つ**（GET / POST / DELETE のいずれも）。
フロントは `data.resource` で分岐すれば中身の型が確定する
（`schema.ts` の `supplementListDataSchema` / `saveSupplementDataSchema` は
`resource` を判別子にした判別可能ユニオン）。

### 1.3 所有者IDを送ってはいけない（実装仕様書 3.2節）

`owner_id` / `ownerId` / `user_id` / `userId` / `owner` / `uid` / `sub` は
**ネストした位置も含めて** 400 で拒否される。行の主キー `id` は更新・削除で使うため
この対象ではない。

### 1.4 楽観ロック（実装仕様書 6.4節）

- 応答の各行は `rowVersion` を持つ。
- **商品・摂取予定・在庫ロットを更新するときは、直前に受け取った `rowVersion` を
  `expectedRowVersion` として必ず送る。** `id` を指定した更新で省略すると 400。
- 版番号が違う／行が消えている場合は **409 `SUPPLEMENT_CONFLICT`**。
  行の不在と版番号違いは**区別されない**（他利用者の行の存在を漏らさないため。
  実装仕様書 6.4節「更新0件を競合（HTTP 409）として扱う」／
  [`docs/database/table-conventions.md`](../database/table-conventions.md) 3.1節）。
  商品・予定・ロットの保存はいずれも更新前に対象行を読むが（アーカイブ日時・残量を
  据え置くため）、**その0件も 404 ではなく 409 で返す**。
- 404 が返るのは**更新対象そのものではなく、入力が参照している別の行**が無いとき
  だけ（`productId` → `SUPPLEMENT_PRODUCT_NOT_FOUND`、服用の `scheduleId` →
  `SUPPLEMENT_NOT_FOUND`）。
- 409 を受けたら **1.8節の対象特定クエリ**で最新の `rowVersion` を取り直して再試行する。
- `rowVersion` はサーバーだけが進める。送っても保存には使われない（比較のみ）。

服用記録は更新せず、訂正時は取消して録り直す。取消と削除における
`expectedRowVersion` の扱いは、それぞれ5.1節と6.3節を参照すること。

### 1.5 在庫を動かす操作はサーバーの原子的RPCだけが行う（**重要**）

`supplement_intake_logs`（服用記録）と `supplement_inventory_movements`（在庫の動き）は、
**ブラウザのセッションからは読み取りしかできない**（migration 20260915000200 が
INSERT / UPDATE / DELETE 権限を誰にも与えていない）。書き手は次の2つの DB 関数だけ。

| 操作 | RPC                        | API                                |
| ---- | -------------------------- | ---------------------------------- |
| 記録 | `record_supplement_intake` | `POST { resource: "intake" }`      |
| 取消 | `void_supplement_intake`   | `POST { resource: "void_intake" }` |

どちらも「記録の作成／取消」と「在庫ロットの増減」と「在庫の動きの追記」を
**単一トランザクション**で行う。途中で失敗すれば全部まとめて巻き戻るので、

- 記録だけ残って在庫が減っていない
- 在庫だけ減って記録が無い
- 在庫は減ったが「どこから引いたか」が残らず、取消しても正しく戻せない

といった半端な状態が原理的に起きない。

**画面がやってはいけないこと**: 在庫の残量を自分で計算して `lot` の更新で減らし、
別途 `intake` を記録する——この2手は原子的でなく、監査証跡も残らない。
在庫を減らすのは常に `resource: "intake"`。

### 1.6 冪等キーは2種類ある（**重要**）

| キー               | 型                 | 対象                     | 役割                                                    |
| ------------------ | ------------------ | ------------------------ | ------------------------------------------------------- |
| `idempotencyKey`   | 文字列（8〜200字） | **服用の記録のみ・必須** | 「この1回の服用」を一意にする。**二重の在庫消費を防ぐ** |
| `clientMutationId` | UUID v4（任意）    | すべての保存             | オフラインキューの再送キー（実装仕様書 6.4節・8.1節）   |

#### `idempotencyKey`（実装仕様書 5.6節）

- **服用の記録（`resource: "intake"`）では必須**。省略すると 400。
- 「いつの、どの予定の服用か」から**決定的に**作る。再送で同じ値になることが要件で、
  ランダムに作り直してはいけない（作り直すと在庫が二重に減る）。

  ```ts
  // 予定に対する服用: 予定IDと予定発生日時から作る
  const idempotencyKey = `${scheduleId}:${scheduledFor}`;
  // 予定外（必要時）の服用: 商品IDと利用者が選んだ日時から作る
  const idempotencyKey = `adhoc:${productId}:${recordedAt}`;
  ```

- 既に使われたキーで記録すると、サーバーは**在庫に一切触れず**当時の記録を返す
  （`outcome: "idempotent_replay"`、HTTP 200）。
- 所有者ごとに閉じているので、別利用者と衝突しない。
- **取消した記録のキーは再利用できない。** 取消後に同じキーで記録すると、
  取消済みの行が `idempotent_replay` として返る（新しい記録は作られない）。
  録り直すときは**別のキー**を使うこと（例: 末尾に `:retry1` を足す）。

#### `clientMutationId`（実装仕様書 6.4節）

- 保存系（`POST`）すべてが受ける。**1つのミューテーションにつき1つの UUID を生成し、
  再送時も同じ値を使う。**
- 既に適用済みなら、サーバーは新しい行を作らず**同じ成功応答**
  （`outcome: "idempotent_replay"`、HTTP 200）を返す。
- **何世代前の再送でも成功応答になる。** 同じ行を `A → B → C` と続けて更新したあとに
  `A` で再送しても 409 にはならず、**`A` が当時返したのと同じ応答**が返る。
  サーバーは適用結果を `supplement_mutation_log` に履歴として持ち、更新の前に必ず
  そこを引く（行の `clientMutationId` は最後の値で上書きされるため、行だけを見ると
  過去のキーが「未適用」に見えてしまう）。
- **同時多重送信でも同じ**。2つのリクエストが同じキーで同時に届いた場合、
  遅れた側は 409 を返さず既存の成功結果を引き直して `idempotent_replay` を返す。
- 記録と取消は**別のミューテーション**なので、別の UUID を使う。記録時のキーで
  再送すれば取消**前**のスナップショットが、取消時のキーで再送すれば取消**後**の
  スナップショットが返る。

> **replay が返すのは「そのミューテーションの当時の行」**で、現在の行ではない。
> `A → B → C` のあとに `A` で再送すると、応答の `rowVersion` は `A` を適用した
> 時点の値（例では 1）になる。**この `rowVersion` を次の更新の
> `expectedRowVersion` に使わないこと**（現在の版番号ではないため 409 になる）。
> 最新の状態が必要なら 1.8節の対象特定クエリで取り直す。
>
> **例外は `stock`**（在庫要約）。これは版番号を持つ行ではなく別テーブルの集計なので、
> replay でも**常に現在の在庫**が載る。在庫は版番号とは無関係に動き続ける値だから。

- 冪等キーを付けられるのは**作成・更新**のみ。`DELETE` は `clientMutationId` を
  受け付けない（削除は 0 件なら 409。既に消えている行の再送はエラーになる）。

### 1.7 保存は「全置換」（PUT 相当）

`product` / `schedule` / `lot` は**そのリソースのあるべき姿を丸ごと**送る。
**省略した任意フィールドは `null` または既定値になる**（前回の値は残らない）。

| 省略したもの                                                  | 保存される値                       |
| ------------------------------------------------------------- | ---------------------------------- |
| `brand` / `ingredientNote` / `safetyNote` / `url`             | `null`                             |
| `defaultAmount` / `amountPerContainer`                        | `null`                             |
| `lowStockThreshold`                                           | `null`（低在庫の判定をしなくなる） |
| `note` / `lotCode` / `purchasedOn` / `openedOn` / `expiresOn` | `null`                             |
| `timezone`                                                    | `"Asia/Tokyo"`（実装仕様書 1章）   |
| `mealRelation`                                                | `"unspecified"`                    |
| `archived`                                                    | 現在の状態のまま（解除されない）   |

**例外は在庫ロットの `remainingQuantity` だけ**。

| 場面 | 省略したときの値                    |
| ---- | ----------------------------------- |
| 作成 | `quantity` と同じ（＝開封前の新品） |
| 更新 | **現在の残量のまま**（触らない）    |

更新で省略時に `quantity` へ戻す仕様にすると、メモを直すたびに消費済みの在庫が
満タンへ復活してしまうため。**残量を意図的に変えるときだけ明示する**（手動調整）。

### 1.8 409 のあとに対象行を特定する（**重要**）

Phase 3b（身体測定フロントエンド）では、409 のあとに「`limit` 付きの一覧を
取り直すだけ」では対象行を見失う不具合が繰り返し見つかった。対象が一覧の何ページ目に
あるか分からないためで、**最新の `rowVersion` を取れないまま再試行できなくなる**。

**対象特定は行の主キー（`id`）で行う。**

`GET /api/supplements?resource=<種類>&id=<UUID>` は、その1件だけを所有者スコープで
直接返す。**一覧の `limit` にも、日時・商品による絞り込みにも一切依存しない。**
`id` は行の生存期間中ずっと変わらないので、次の判定がそのまま成立する。

| 結果            | 意味                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `entries` に1件 | それが最新の状態。`rowVersion` を取り直して再試行できる              |
| `entries` が空  | **本当に削除された**（またはもう所有していない）。編集を破棄してよい |

#### 409 からの復帰手順

1. 編集開始時にサーバーから受け取った **`id`**（送信値ではなく永続値）で
   `GET /api/supplements?resource=<種類>&id=<id>` を投げる。
2. 1件返れば、その `rowVersion` を `expectedRowVersion` にして再送する。
3. 0件なら、その行は削除されている。編集を破棄して一覧へ戻す。

```ts
import {
  buildSupplementRefetchQuery,
  interpretSupplementRefetch,
} from "@/features/supplements/conflict";

// original は「編集開始時にサーバーから受け取った行」
const { strategy, params } = buildSupplementRefetchQuery({
  resource: "schedule",
  id: original.id,
  productId: original.productId,
  scheduleKind: original.scheduleKind,
  startDate: original.startDate,
});
const res = await fetch(`/api/supplements?${params}`);
const { data } = await res.json();

const outcome = interpretSupplementRefetch(strategy, data.entries);
// outcome.kind === "found"     → outcome.entry.rowVersion で再試行
// outcome.kind === "deleted"   → 削除済み（id で引いて0件だったときだけ）
// outcome.kind === "unresolved"→ 断定できない（一覧を取り直す）
```

`id` は他の絞り込み（`from` / `to` / `cursor` / `productId` / `status`）と
**併用できない**（併用すると 400）。1件取得が「他の条件に依存しない」ことに意味が
あるためで、併用を黙って無視すると、呼び出し側が絞り込みが効いていると誤解したまま
結果を読んでしまう。

#### 商品には対象特定クエリが要らない

商品（`products`）はページングせず、**どの `GET /api/supplements` の応答にも全件入る**
（アーカイブ済みを含む）。一覧から `id` で引き直せばよい（追加のリクエストは要らない）。

#### `id` をまだ持っていないとき（新規作成の重複競合）

新規作成が 409 `SUPPLEMENT_DUPLICATE_CONFLICT` になったときだけは `id` が無い。

| リソース   | 重複の原因                                       | 対象特定の方法                                        |
| ---------- | ------------------------------------------------ | ----------------------------------------------------- |
| 商品       | `productKey` または正規化した `name` の重複      | 応答の `products` から `productKey` / `name` で探す   |
| 摂取予定   | (商品, 種別, 開始日, 時刻) の重複                | `productId` で1ページ読み、種別と開始日で突き合わせる |
| 在庫ロット | (商品, `lotCode`) の重複（`lotCode` 指定時のみ） | `productId` で1ページ読み、`lotCode` で突き合わせる   |

`buildSupplementRefetchQuery` に `id` を渡さなければこの後退手段のクエリを組み立て、
`interpretSupplementRefetch(strategy, entries, target)` が突き合わせまで行う。

> **この方法の0件は「削除された」を意味しない。**
> 競合した側の更新が**その識別子そのものを書き換えていた**場合も0件になる
> （行はまだある）。だから `id` を持っているときは必ず `id` で引くこと。
> `interpretSupplementRefetch` は識別子で引いた0件を `"unresolved"` として返し、
> 「削除された」と断定しない。

### 1.9 エラーコード一覧

| コード                          | HTTP | 発生条件                                                                                             | 画面での扱い                                |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `SAME_ORIGIN_REQUIRED`          | 403  | `Origin` / `Sec-Fetch-Site` が同一オリジンでない                                                     | 実装バグ。相対URLで `fetch` する            |
| `AUTHENTICATION_REQUIRED`       | 401  | 検証済みセッションが無い                                                                             | `/auth` へ誘導                              |
| `ACCOUNT_INACTIVE`              | 403  | `users.status` が `active` 以外                                                                      | 処理中の案内を出す（実装仕様書 5.1節）      |
| `ACCOUNT_SERVICE_UNAVAILABLE`   | 503  | Supabase 未設定（実装仕様書 3.3節）                                                                  | デモモードへ誘導                            |
| `JSON_REQUIRED`                 | 415  | `Content-Type` が `application/json` でない                                                          | 実装バグ                                    |
| `PAYLOAD_TOO_LARGE`             | 413  | ボディが 64 KiB 超                                                                                   | 入力を分割する                              |
| `INVALID_REQUEST`               | 400  | JSON 不正／スキーマ不一致／未知フィールド／所有者IDの持ち込み／不正な `cursor`／在庫ロットの商品変更 | `message` をフォームエラーとして表示        |
| `SUPPLEMENT_PRODUCT_NOT_FOUND`  | 404  | 入力が**参照する** `productId` が所有者スコープに無い（更新対象そのものではない）                    | 商品一覧を取り直す                          |
| `SUPPLEMENT_PRODUCT_ARCHIVED`   | 400  | アーカイブ済み商品へ新規の予定・ロット・服用を登録しようとした                                       | アーカイブ解除を促す（2.3節）               |
| `SUPPLEMENT_NOT_FOUND`          | 404  | 服用記録が**参照する** `scheduleId` が所有者スコープに無い（またはその商品の予定でない）             | 予定一覧を取り直す                          |
| `SUPPLEMENT_UNIT_MISMATCH`      | 400  | ロットの単位が商品の既定単位と違う／服用の単位を換算できない／**在庫ロットがある商品の単位を変えた** | **4.3節・2.4節**                            |
| `SUPPLEMENT_INSUFFICIENT_STOCK` | 409  | **在庫が足りず FEFO 消費を完了できない**                                                             | **4.4節**。在庫の登録か消費量の見直しを促す |
| `SUPPLEMENT_CONFLICT`           | 409  | 版番号不一致、または**更新・削除・取消の対象行が無い**（1.4節）                                      | 1.8節の手順で復帰する                       |
| `SUPPLEMENT_DUPLICATE_CONFLICT` | 409  | 商品名・商品キー・予定・ロット名の重複                                                               | 1.8節の後退手段で既存を探して編集へ倒す     |
| `SUPPLEMENT_LOT_IN_USE`         | 409  | 服用に使われた在庫ロットを削除しようとした                                                           | **6節**。残量の調整（0 にする）を促す       |

上表は**本APIから返りうるコードの全部**。`API_ERROR_CODES` にはこのほか
身体測定・睡眠・水分・体調用のコード、`REAUTHENTICATION_REQUIRED`、`NOT_IMPLEMENTED`
があるが、本APIの経路からは返らない。

コードの定義は [`src/server/api/errors.ts`](../../src/server/api/errors.ts) の `API_ERROR_CODES`。
将来コードが増えうるため、フロントは**未知のコードを `message` の表示で扱えるようにしておく**
（`apiErrorResponseSchema` の `code` は `z.string()`）。

---

## 2. 商品

### 2.1 `SupplementProduct` の応答形

```jsonc
{
  "id": "4f0f…",
  "productKey": "vitamin_c", // stableKey。作成後は変更できない
  "name": "ビタミンC",
  "nameNormalized": "ビタミンc", // 重複判定に使われた正規化キー（2.2節）
  "brand": "テストブランド",
  "category": "vitamin",
  "form": "tablet",
  "defaultAmount": 2,
  "defaultUnit": "tablet", // ★ 在庫の単位でもある（2.4節）
  "amountPerContainer": 120,
  "lowStockThreshold": 10,
  "ingredientNote": null,
  "safetyNote": null,
  "url": "https://example.com/vitamin-c",
  "archivedAt": null,
  "stock": {
    // ★ 在庫の要約（2.5節）
    "remainingTotal": 42,
    "lotCount": 2,
    "nearestExpiresOn": "2027-01-31",
    "lowStock": false,
  },
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z",
}
```

`category` / `form` / `defaultUnit` の取りうる値は `units.ts` の
`SUPPLEMENT_CATEGORIES`（8種）/ `SUPPLEMENT_FORMS`（7種）/ `SUPPLEMENT_UNITS`（11種）。

| 定数                    | 値                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `SUPPLEMENT_CATEGORIES` | `vitamin` `mineral` `protein` `amino_acid` `fiber` `probiotic` `botanical` `other` |
| `SUPPLEMENT_FORMS`      | `tablet` `capsule` `powder` `liquid` `gummy` `granule` `other`                     |
| `SUPPLEMENT_UNITS`      | `tablet` `capsule` `gummy` `sachet` `scoop` `drop` `piece` `g` `mg` `mcg` `ml`     |

表示ラベル（日本語）は画面側で持つ。DB とスキーマは英語の識別子だけを扱う。

### 2.2 名称の重複は禁止（実装仕様書 5.6節）

> 名称正規化またはstableKeyの重複を禁止する。

所有者ごとに次の2つが一意。どちらかがぶつかると 409 `SUPPLEMENT_DUPLICATE_CONFLICT`。

1. `productKey`（stableKey）
2. 正規化した `name`（`nameNormalized`）

正規化は **NFKC → 空白の畳み込み → 前後の空白除去 → 小文字化** の順。
つまり次はすべて**同じ商品名**として扱われる。

| 入力                 | 正規化後         |
| -------------------- | ---------------- |
| `Ｖｉｔａｍｉｎ　Ｃ` | `vitamin c`      |
| `  FISH   OIL  `     | `fish oil`       |
| `ﾏﾙﾁﾋﾞﾀﾐﾝ`           | `マルチビタミン` |

フロントは送信前に `normalizeSupplementName(name)` で手元の一覧と突き合わせて
「その名前は既に登録されています」と出せる（**最終判定は DB の一意制約**なので、
この事前チェックに頼りきらないこと）。

### 2.3 アーカイブ（削除はしない）

商品は**削除できない**（`DELETE` の対象外）。消すと紐づく服用記録・在庫・監査証跡が
すべて道連れになるため。無効化は `archived: true` で行う。

- アーカイブ済み商品へ**新規の**予定・在庫ロット・服用を登録すると 400
  `SUPPLEMENT_PRODUCT_ARCHIVED`。
- 既存行の訂正（更新）は妨げない。
- 解除は `archived: false`。
- アーカイブ済みも `products` に含まれて返る（過去の記録のラベル解決に要るため）。
  一覧画面では `archivedAt !== null` で絞って隠す。

### 2.4 `defaultUnit` は在庫の単位でもある（**重要**）

在庫ロットの数量・残量・消費量は**すべて商品の `defaultUnit` で数える**。
DB のトリガーがロットの単位を商品の単位に揃えることを強制する。

そのため、**在庫ロットが1件でもある商品の `defaultUnit` は変更できない**。
変更しようとすると 400 `SUPPLEMENT_UNIT_MISMATCH` で拒否される
（残量 0 のロットも「1件」に数える。行は残り続けるため）。

| 場面                                     | 結果                           |
| ---------------------------------------- | ------------------------------ |
| ロットが0件の商品の `defaultUnit` を変更 | 通る                           |
| ロットが1件以上ある商品で**同じ**単位    | 通る（変更ではないため）       |
| ロットが1件以上ある商品で**違う**単位    | 400 `SUPPLEMENT_UNIT_MISMATCH` |

単位を変えたいときは、**先に在庫ロットを削除する**か、別の商品として登録し直して
古い商品をアーカイブする。画面では、在庫があるときに単位のセレクトを無効化して
このエラーに当てないのが親切。

> **なぜ拒否するのか。** ロット側のトリガーはロットの INSERT / UPDATE でしか
> 単位一致を見ないため、商品側だけを後から変えると素通りしてしまう。
> 既存ロットが `tablet` のまま商品が `g` になると、そのあとの FEFO 消費が
> 単位の違う数量を数値だけで減算する（`g` の服用で `tablet` のロットが減る）。
> API 層の事前検査と migration `20260921000200` のトリガーの二重で止める。

### 2.5 `stock`（在庫の要約）

どの応答の商品にも付く、その商品の在庫のまとめ。

| フィールド         | 意味                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `remainingTotal`   | 全ロットの残量合計（`defaultUnit` で数える）                          |
| `lotCount`         | **残量が 0 より大きい**ロットの件数                                   |
| `nearestExpiresOn` | 残量のあるロットのうち最も近い使用期限。無ければ `null`               |
| `lowStock`         | `lowStockThreshold` が設定され、`remainingTotal <= lowStockThreshold` |

`lowStockThreshold` が `null` の商品は `lowStock` が常に `false`（判定しない）。

`units.ts` の `isLowStock()` / `isExpiringSoon()` で同じ判定をフロントでも行える
（期限接近の既定幅は30日。既に期限切れのロットも「接近」に含める）。

### 2.6 `POST` — 商品の保存

```jsonc
// 作成
{
  "resource": "product",
  "clientMutationId": "…", // 任意
  "product": {
    "productKey": "vitamin_c", // 作成時のみ必須・以後変更不可
    "name": "ビタミンC",
    "category": "vitamin",
    "form": "tablet",
    "defaultAmount": 2,
    "defaultUnit": "tablet",
    "amountPerContainer": 120,
    "lowStockThreshold": 10,
    "url": "https://example.com/vitamin-c",
  },
}
```

```jsonc
// 更新（productKey は送らない。送ると 400）
{
  "resource": "product",
  "product": {
    "id": "4f0f…",
    "expectedRowVersion": 1,
    "name": "ビタミンC 1000mg",
    "category": "vitamin",
    "form": "tablet",
    "defaultUnit": "tablet",
    "archived": false,
  },
}
```

応答: `{ "data": { "resource": "product", "product": SupplementProduct, "outcome": … } }`
（作成 `201`、更新・replay `200`）

| 制約                            | 値                                                         |
| ------------------------------- | ---------------------------------------------------------- |
| `productKey`                    | `^[a-z][a-z0-9_]{1,49}$`                                   |
| `name`                          | 1〜200文字（正規化して空になる名前は 400）                 |
| `brand`                         | 1〜100文字                                                 |
| `defaultAmount`                 | 0超 100,000以下、小数第4位まで                             |
| `amountPerContainer`            | 0超 1,000,000以下、小数第4位まで                           |
| `lowStockThreshold`             | **0以上** 1,000,000以下、小数第4位まで                     |
| `ingredientNote` / `safetyNote` | 1〜2,000文字                                               |
| `url`                           | `https://` で始まること（`http://`・`javascript:` は 400） |

---

## 3. 摂取予定

### 3.1 `SupplementSchedule` の応答形

```jsonc
{
  "id": "6a1b…",
  "productId": "4f0f…",
  "productKey": "vitamin_c", // 商品を引き直さずにラベルを出せる
  "productName": "ビタミンC",
  "scheduleKind": "daily", // once / daily / weekly / as_needed
  "timeOfDay": "08:00", // HH:MM。as_needed のときは null
  "timezone": "Asia/Tokyo",
  "weekdays": null, // weekly のときだけ配列（0=日〜6=土）
  "startDate": "2026-09-01",
  "endDate": null,
  "amount": 2,
  "unit": "tablet",
  "mealRelation": "after_meal", // unspecified / before_meal / with_meal / after_meal / as_labeled
  "note": null,
  "archivedAt": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z",
}
```

### 3.2 種別ごとの必須・禁止（実装仕様書 5.6節）

> 終了日は開始日以降、週次は曜日必須。

| `scheduleKind` | `timeOfDay`  | `weekdays`                         | `endDate`                       |
| -------------- | ------------ | ---------------------------------- | ------------------------------- |
| `once`         | **必須**     | 送れない                           | 省略か `startDate` と同じ日のみ |
| `daily`        | **必須**     | 送れない                           | 省略か `startDate` 以降         |
| `weekly`       | **必須**     | **必須**（1〜7件・0〜6・重複なし） | 省略か `startDate` 以降         |
| `as_needed`    | **送れない** | 送れない                           | 省略か `startDate` 以降         |

違反はすべて 400 `INVALID_REQUEST`（Zod が弾くので DB には届かない）。
同じ判定を DB の CHECK 制約も持っている（最終防衛線）。

### 3.3 `POST` — 予定の保存

```jsonc
{
  "resource": "schedule",
  "clientMutationId": "…",
  "schedule": {
    "productId": "4f0f…",
    "scheduleKind": "weekly",
    "timeOfDay": "08:00",
    "weekdays": [1, 3, 5],
    "startDate": "2026-09-01",
    "endDate": null,
    "amount": 2,
    "unit": "tablet",
    "mealRelation": "after_meal",
  },
}
```

応答: `{ "data": { "resource": "schedule", "schedule": SupplementSchedule, "outcome": … } }`

(商品, 種別, 開始日, 時刻) が同じ予定は2件作れない（409 `SUPPLEMENT_DUPLICATE_CONFLICT`）。
更新では `productId` を変えてよい（別商品へ移せる）。

### 3.4 予定は「発生」を持たない

**サーバーは予定を日時へ展開しない。** 予定は繰り返しのルールであり、
「今日の 08:00 の分」という行はどこにも存在しない。

画面が予定から「今日飲むべきもの」を組み立て、服用を記録するときに
`scheduleId` と `scheduledFor`（その発生の日時、`timestamptz`）を添えて送る。
`idempotencyKey` もこの2つから決定的に作ること（1.6節）。

`supplement_summary` の `weeklyScheduledCount` だけはサーバーが数える（7節）。

---

## 4. 服用の記録（**FEFO 在庫消費**）

### 4.1 `SupplementIntake` の応答形

```jsonc
{
  "id": "8c2d…",
  "productId": "4f0f…",
  "productKey": "vitamin_c",
  "productName": "ビタミンC",
  "scheduleId": "6a1b…", // 予定外の服用では null
  "status": "taken", // taken / skipped / voided / as_needed
  "scheduledFor": "2026-09-15T08:00:00.000Z",
  "recordedAt": "2026-09-15T09:00:00.000Z",
  "timezone": "Asia/Tokyo",
  "amount": 2,
  "unit": "tablet",
  "consumedQuantity": 2, // ★ 実際に在庫から引いた量（4.5節）
  "idempotencyKey": "6a1b…:2026-09-15T08:00:00.000Z",
  "voidedAt": null,
  "voidReason": null,
  "note": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-09-15T09:00:00.000Z",
  "updatedAt": "2026-09-15T09:00:00.000Z",
}
```

### 4.2 `POST` — 服用の記録

```jsonc
{
  "resource": "intake",
  "clientMutationId": "…", // 任意（オフライン再送用）
  "intake": {
    "productId": "4f0f…",
    "idempotencyKey": "6a1b…:2026-09-15T08:00:00.000Z", // 必須（8〜200文字）
    "recordedAt": "2026-09-15T09:00:00Z",
    "status": "taken", // 省略時 taken。voided は指定不可
    "amount": 2, // 省略時は商品の defaultAmount
    "unit": "tablet", // 省略時は商品の defaultUnit
    "scheduleId": "6a1b…", // 予定に対する記録なら
    "scheduledFor": "2026-09-15T08:00:00Z",
    "consumeQuantity": 2, // 省略時は 4.3節の規則
    "note": null,
  },
}
```

応答（作成 `201` / replay `200`）:

```jsonc
{
  "data": {
    "resource": "intake",
    "intake": SupplementIntake,
    "stock": { "remainingTotal": 40, "lotCount": 2, "nearestExpiresOn": "2027-01-31", "lowStock": false },
    "outcome": "created"        // created | idempotent_replay
  }
}
```

**`stock` は消費後の在庫要約**。これを使えば、記録のたびに一覧を取り直さなくても
低在庫の警告バッジを更新できる。

**記録は更新できない。** `id` / `expectedRowVersion` は受け付けない（送ると 400）。
訂正は「取り消して録り直す」（5節）。在庫を動かした記録をあとから書き換えられると、
消費量と実際の在庫の対応が崩れるため。

### 4.3 在庫から引く量（`consumeQuantity`）の決まり方

在庫は商品の `defaultUnit` で数える（2.4節）。`consumeQuantity` も**常に在庫の単位**。

| 場面                                            | 引かれる量                         |
| ----------------------------------------------- | ---------------------------------- |
| `consumeQuantity` を明示した                    | その値                             |
| 省略 & `status: "skipped"`                      | `0`                                |
| 省略 & `unit` が商品の `defaultUnit` と同じ     | `amount`                           |
| 省略 & `unit` が商品の `defaultUnit` と**違う** | **400 `SUPPLEMENT_UNIT_MISMATCH`** |

最後の行が重要。たとえば「1錠 = 500mg」の商品に `{ amount: 500, unit: "mg" }` で
記録しようとすると、サーバーは「何錠引けばいいか」を知らない。黙って 0 にすると
在庫が減らないまま「服用済み」になり、利用者は減らない在庫の理由を知りようがない。
**換算はアプリ側の責任**として、`consumeQuantity: 1` を明示させる。

`consumeQuantity: 0` を明示すれば、**在庫を引かずに記録だけ残せる**
（外出先で手持ちの別ボトルから飲んだ、など）。

`status: "skipped"` で `consumeQuantity` に 0 以外を送ると 400。

### 4.4 FEFO 消費と在庫不足（**重要**）

> 服用時は期限が近いロットから消費（FEFO）し、負在庫となる操作は原子的RPCが拒否する。
> （実装仕様書 5.6節）

#### 消費の順序

サーバーは所有者のその商品のロットのうち**残量が 0 より大きいもの**を、次の順に並べて
先頭から引いていく。1つで足りなければ次のロットへ繰り越す（1回の服用が複数ロットに
またがる）。

1. **使用期限が近い順**（`expiresOn` 昇順。**未設定は最後**）
2. 期限が同じなら**開封済みを先に**（`openedOn` 昇順。未開封は最後）
3. それも同じなら**購入が古い順**（`purchasedOn` 昇順。未設定は最後）
4. それも同じなら**登録が古い順**（`createdAt` → `id`）

2〜4 は、期限が同じロットが複数あるときに「どれから引いたか」が実行ごとに変わらない
ようにするための決定性の担保。

`units.ts` の `sortLotsByFefo()` / `planFefoConsumption()` が**同じ順序**を再現する。
送信前に「どのロットからいくつ引かれる見込みか」を画面へ出せる。

```ts
import { planFefoConsumption } from "@/features/supplements/units";

const plan = planFefoConsumption(lotsOfThisProduct, consumeQuantity);
// plan.steps     → [{ lotId, quantity }, …]（FEFO 順の割り当て）
// plan.shortfall → 0 より大きければ在庫不足の見込み
```

#### 在庫が足りないとき

引き当てきれなければ **HTTP 409 `SUPPLEMENT_INSUFFICIENT_STOCK`**。

```jsonc
{
  "error": {
    "code": "SUPPLEMENT_INSUFFICIENT_STOCK",
    "message": "在庫が足りないため記録できませんでした。在庫を登録するか、消費量を見直してください。",
  },
}
```

**このとき記録は1件も作られず、ロットの残量も1ミリも動かない**（トランザクション全体が
巻き戻る）。在庫の動きにも「引こうとした」跡は残らない。安全に再試行してよい。

> **なぜ 400 ではなく 409 か。** これは入力の誤りではなく**状態の競合**だから。
> 同じリクエストでも、在庫を補充すれば通る。画面も「入力が間違っています」ではなく
> 「在庫が足りません。在庫を登録しますか？」という導線にすること。

**画面での扱い（推奨）**

1. 送信前に `planFefoConsumption()` で `shortfall > 0` なら警告を先に出す
   （「在庫が足りません（あと N tablet）」）。
2. それでも 409 は起こりうる（送信までの間に別端末が消費した、など）。
   409 を受けたら在庫ロットの登録画面へ誘導するか、`consumeQuantity: 0` で
   「在庫を引かずに記録だけ残す」選択肢を出す。
3. `shortfall` の事前判定を**送信のブロックに使わない**こと。サーバーが正であり、
   フロントの在庫は常に少し古い。

#### 同時実行

同じ利用者の同時操作はサーバー側で**所有者単位に直列化**される
（`pg_advisory_xact_lock`）。残量3に対して2錠の服用が2件同時に届いても、通るのは
1件だけで、もう1件は 409。負在庫は DB の CHECK 制約（`remaining_quantity >= 0`）でも
二重に禁じられている。

### 4.5 `consumedQuantity` は取消しても 0 に戻らない

`consumedQuantity` は**記録した時点で実際に引いた量**であり、履歴としてそのまま残る。
取り消しても値は変わらない（在庫は戻る）。

在庫が戻っているかどうかは **`status === "voided"`** で判断すること。
`consumedQuantity` を「いま在庫を押さえている量」と読まないこと。

### 4.6 状態（`status`）

| 値          | 意味                       | 在庫               | 集計（服用数） |
| ----------- | -------------------------- | ------------------ | -------------- |
| `taken`     | 予定どおり服用した         | 引く               | 数える         |
| `as_needed` | 予定外に服用した（必要時） | 引く               | 数える         |
| `skipped`   | 飲まなかった               | 引かない（必ず 0） | 数えない       |
| `voided`    | 取り消した                 | 戻す（5節）        | 数えない       |

`voided` は記録時に指定できない（400）。取消は `resource: "void_intake"` 専用。
在庫を戻さずに「取消済み」の記録を作れてしまうと在庫が合わなくなるため。

---

## 5. 服用の取消（在庫の復元）

### 5.1 `POST` — 取消

```jsonc
{
  "resource": "void_intake",
  "clientMutationId": "…", // 任意（記録時とは別の UUID を使う）
  "void": {
    "id": "8c2d…", // 取り消す記録の主キー（必須）
    "expectedRowVersion": 1, // 任意。画面からは必ず送ること
    "reason": "誤って記録した", // 任意、1〜200文字
  },
}
```

応答（常に `200`）:

```jsonc
{
  "data": {
    "resource": "void_intake",
    "intake": SupplementIntake,   // status: "voided"、voidedAt / voidReason が入る
    "stock": { … },               // 復元後の在庫要約
    "outcome": "voided"           // voided | idempotent_replay
  }
}
```

### 5.2 何度取り消しても安全

- 既に取消済みの記録への取消は **409 にならない**。在庫に一切触れず、その行を
  `outcome: "idempotent_replay"` で返す（版番号も進まない）。
- `expectedRowVersion` の検査は**取消済み判定の後**に行う。1回目の取消で版番号が
  進んでいるため、先に版番号を見ると正常な再送が 409 になってしまう。
- 対象が存在しない／自分のものでない／版番号が本当に食い違う場合は
  409 `SUPPLEMENT_CONFLICT`。1.8節の手順で復帰する。

### 5.3 復元は「消費したロットへ、消費した量だけ」（**重要**）

1回の服用が複数ロットにまたがっていた場合、合計だけ戻すのでは**どのロットに戻すかが
決まらない**。サーバーは消費を `supplement_inventory_movements` に**ロット単位で1行ずつ**
記録しており、取消はそれを読み返して**同じロットへ同じ量**を戻す。

例（早い期限のロット3錠 + 遅い期限のロット10錠、5錠を服用）:

| 操作      | early | late | 在庫の動き                                                      |
| --------- | ----- | ---- | --------------------------------------------------------------- |
| 初期      | 3     | 10   | `purchase +3`, `purchase +10`                                   |
| 5錠を服用 | 0     | 8    | `intake_consume -3`(early), `intake_consume -2`(late)           |
| 取消      | 3     | 10   | `intake_void_restore +3`(early), `intake_void_restore +2`(late) |

`late` へまとめて 5 戻すのではなく、**元の配分どおり**に戻る。

#### 手動調整との組み合わせ（端）

消費したあとで利用者が**残量を手動で減らす調整**をしていた場合だけ、単純に足すと
ロットの初期数量（`quantity`）を超えてしまう。そのときは初期数量で**頭打ち**にして
取消自体は成立させ、在庫の動きには**実際に戻した量**が記録される。

（取消をエラーにして利用者を詰ませるより、事実を正確に残す方を採っている。）

### 5.4 取り消した記録の録り直し

取消後に在庫はすぐ再利用できる。ただし **`idempotencyKey` は再利用できない**
（取消済みの行が replay として返ってしまう）。録り直すときは別のキーを使うこと。

```ts
const retryKey = `${originalKey}:retry${attempt}`;
```

---

## 6. 在庫ロット

### 6.1 `SupplementLot` の応答形

```jsonc
{
  "id": "9d3e…",
  "productId": "4f0f…",
  "productKey": "vitamin_c",
  "productName": "ビタミンC",
  "lotCode": "L-001", // 任意の表示名。指定すると商品内で一意
  "quantity": 60, // 入荷時の数量
  "remainingQuantity": 42, // 残量。0 未満にも quantity 超にもならない
  "unit": "tablet", // 必ず商品の defaultUnit と同じ
  "purchasedOn": "2026-08-01",
  "openedOn": "2026-08-10",
  "expiresOn": "2027-01-31",
  "note": null,
  "rowVersion": 1,
  "clientMutationId": null,
  "createdAt": "2026-08-01T00:00:00.000Z",
  "updatedAt": "2026-08-10T00:00:00.000Z",
}
```

服用・取消では、残量が増減した**各在庫ロットの `rowVersion` も進む**。服用・取消の
成功後は、画面が保持しているロットの版番号と残量を使い続けず、ロット一覧を取り直すこと。

### 6.2 `POST` — ロットの登録・調整

```jsonc
// 登録（remainingQuantity を省くと quantity と同じ = 開封前の新品）
{
  "resource": "lot",
  "clientMutationId": "…",
  "lot": {
    "productId": "4f0f…",
    "lotCode": "L-001",
    "quantity": 60,
    "purchasedOn": "2026-08-01",
    "expiresOn": "2027-01-31",
  },
}
```

```jsonc
// 残量の手動調整（数え直した・こぼした）
{
  "resource": "lot",
  "lot": {
    "id": "9d3e…",
    "expectedRowVersion": 3,
    "productId": "4f0f…", // 変更不可。現在の商品と同じ値を送る
    "lotCode": "L-001",
    "quantity": 60,
    "remainingQuantity": 38, // ★ 明示したときだけ動く
    "expiresOn": "2027-01-31",
  },
}
```

応答: `{ "data": { "resource": "lot", "lot": SupplementLot, "stock": …, "outcome": … } }`

| 制約                     | 内容                                                   |
| ------------------------ | ------------------------------------------------------ |
| `quantity`               | 0超 1,000,000以下、小数第4位まで                       |
| `remainingQuantity`      | **0以上 `quantity` 以下**（違反は 400、DB でも CHECK） |
| `unit`                   | 省略推奨。送る場合は商品の `defaultUnit` と一致必須    |
| `openedOn` / `expiresOn` | `purchasedOn` 以降                                     |
| `lotCode`                | 1〜50文字。**指定すると商品内で一意**（重複は 409）    |
| `productId`              | **作成後は変更できない**（変えると 400）               |

`lotCode` を省いたロットは何件でも作れる（`null` 同士は衝突しない）。
ただし `lotCode` が無いと 1.8節の後退手段が使えないので、**登録直後に応答の `id` を
必ず保持すること**。

残量を明示して変えると、在庫の動きに `adjustment` として記録される（8節）。

### 6.3 `DELETE` — ロット・予定の削除

```jsonc
{ "resource": "lot", "id": "9d3e…", "expectedRowVersion": 3 }
{ "resource": "schedule", "id": "6a1b…", "expectedRowVersion": 1 }
```

応答: `{ "data": { "resource": "lot", "deletedId": "9d3e…" } }`

削除できるのは**摂取予定と在庫ロットだけ**（`product` / `intake` を送ると 400）。

- **服用に使われたロットは削除できない** → 409 `SUPPLEMENT_LOT_IN_USE`。
  消すと「どのロットからいくつ引いたか」の記録も道連れになり、取消が正しい復元先を失う。
  **その服用を取消済みにしても、使用履歴は残るためロットは永久に削除できない。**
  使い切ったロットを一覧から消したい場合は、`remainingQuantity: 0` に調整して
  画面側で非表示にする。
- 打ち間違えた（まだ一度も服用に使っていない）ロットは削除できる。
- `expectedRowVersion` は省略可。省略すると版番号を見ずに削除する。
  一覧から消すときも**送ることを推奨**（別端末の変更に気づける）。
- 0件（対象なし・版番号不一致）は 409 `SUPPLEMENT_CONFLICT`。

予定を削除しても、その予定に紐づいていた服用記録は**残る**（`scheduleId` が `null` に
なるだけ）。服用の事実は予定より長生きする。

---

## 7. `GET /api/supplements` — 一覧の取得

### クエリパラメータ

| 名前        | 既定     | 説明                                                                       |
| ----------- | -------- | -------------------------------------------------------------------------- |
| `resource`  | `intake` | `schedule` / `lot` / `intake` / `movement`                                 |
| `id`        | —        | 指定するとその1件だけ。**他の絞り込みと併用不可**（1.8節）                 |
| `from`      | —        | 時間軸 >= from（含む）。ISO 8601（オフセット付き）                         |
| `to`        | —        | 時間軸 <= to（含む）                                                       |
| `order`     | `desc`   | `asc` / `desc`                                                             |
| `limit`     | `100`    | 1〜500                                                                     |
| `cursor`    | —        | 前ページの `page.nextCursor` をそのまま渡す（不透明な文字列）              |
| `productId` | —        | どの `resource` でも使える商品での絞り込み                                 |
| `status`    | —        | `resource=intake` のときだけ。`taken` / `skipped` / `voided` / `as_needed` |

`from` / `to` が比較する列は `resource` ごとに違う。

| `resource` | 時間軸       | 備考                                                     |
| ---------- | ------------ | -------------------------------------------------------- |
| `schedule` | `createdAt`  | 予定は少ないので `limit=500` で1ページに収まることが多い |
| `lot`      | `createdAt`  | 表示順は `sortLotsByFefo()` でフロント側に任せる         |
| `intake`   | `recordedAt` | 服用履歴の主軸                                           |
| `movement` | `occurredAt` | 在庫の動き（監査証跡）                                   |

**商品（`products`）は一覧リソースではない**（`resource=product` は 400）。
どの応答にも全件入る（2.3節）。

### 応答 `200`

```jsonc
{
  "data": {
    "resource": "intake",
    "entries": [ SupplementIntake, … ],
    "products": [ SupplementProduct, … ],   // 全件（アーカイブ済みを含む）。正規化名順
    "summary": {
      "weeklyScheduledCount": 7,
      "weeklyTakenCount": 5,
      "monthlyTakenCount": 22,
      "lowStockProductCount": 1,
      "expiringLotCount": 0
    },
    "page": { "limit": 100, "order": "desc", "nextCursor": "eyJ0…" }
  }
}
```

### `summary`（実装仕様書 5.6節「集計」）

| フィールド             | 意味                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `weeklyScheduledCount` | 当日を含む直近7ローカル日の予定回数（`as_needed` は数えない）      |
| `weeklyTakenCount`     | 同じ直近7ローカル日の服用回数（取消・スキップは除く）              |
| `monthlyTakenCount`    | 直近30日間の服用回数                                               |
| `lowStockProductCount` | 有効な低在庫商品の数（しきい値があり、残量合計がそれ以下）         |
| `expiringLotCount`     | 有効な商品の期限接近ロット数（残量あり・30日以内。期限切れも含む） |

`weeklyScheduledCount` は予定の展開規則（daily は毎日1回、weekly は対象曜日、
once は開始日、`as_needed` は 0回）に従ってサーバーが数える。週の予定数と服用数は
どちらも `Asia/Tokyo` のローカル日境界で切り、当日から6日前までの同じ7日を対象にする。
低在庫商品数と期限接近ロット数は、どちらもアーカイブ済み商品を対象外とする。

服用率は `weeklyTakenCount / weeklyScheduledCount` で出せるが、**予定外の服用
（`as_needed`）が分子に入る**ため 100% を超えうる。画面では上限を切るか、
「予定 7 / 服用 5」のように両方を並べて出すこと。

### ページング方式（キーセット／カーソル）

オフセット方式は、ページ送りの最中に新しい記録が入ると行の取りこぼし・重複が起きる。
本APIは `(時間軸, id)` のキーセット方式を使う。

- `page.nextCursor` が `null` でなければ次ページがある。
- 次ページは `cursor=<nextCursor>` を付けて**同じ条件で**もう一度呼ぶ
  （`order` / `limit` / 絞り込みを変えないこと）。
- カーソルは不透明な文字列。中身を解釈・生成しないこと。壊れた値は 400。

---

## 8. 在庫の動き（監査証跡）

`resource=movement` で読める追記専用の記録。**ブラウザからは書けない**（1.5節）。

```jsonc
{
  "id": "aa4f…",
  "productId": "4f0f…",
  "productKey": "vitamin_c",
  "productName": "ビタミンC",
  "lotId": "9d3e…",
  "intakeLogId": "8c2d…", // 服用に伴う動きならその記録のID
  "movementKind": "intake_consume",
  "quantityDelta": -2, // 残量の増減。消費は負、復元・登録は正
  "unit": "tablet",
  "occurredAt": "2026-09-15T09:00:00.000Z",
  "note": null,
  "createdAt": "2026-09-15T09:00:00.000Z",
}
```

| `movementKind`        | いつ作られるか                      | `quantityDelta` | `intakeLogId` |
| --------------------- | ----------------------------------- | --------------- | ------------- |
| `purchase`            | 在庫ロットを登録したとき            | 正（初期残量）  | `null`        |
| `intake_consume`      | 服用の FEFO 消費（ロットごとに1行） | 負              | あり          |
| `intake_void_restore` | 取消による復元（ロットごとに1行）   | 正              | あり          |
| `adjustment`          | 残量を手動で変えたとき              | 正または負      | `null`        |

残量が動かない更新（メモの訂正など）は記録されない。
残量 0 で登録したロットにも `purchase` 行は作られない（動いていないため）。

**この表は「なぜ在庫がこの数になったか」の唯一の説明**であり、取消の復元もここを
読んで行われる。画面では商品ごとの在庫履歴として `productId` で絞って出せる。

---

## 9. Phase 4-2a の範囲外（フロント実装時の前提）

| 事項                     | 状況                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| サプリメント画面         | **Phase 4-2b（Kimi K2.7 Code）で実装**。本書と `schema.ts` を前提にする |
| CSV 出力                 | 未実装（実装仕様書 5.6節）。`/api/reports` の整備後に扱う               |
| 予定のリマインド通知     | 未実装（実装仕様書 5.12節の通知フェーズ）                               |
| オフラインキューへの接続 | 未実装（実装仕様書 8.1節）。`clientMutationId` の受け口だけ用意済み     |
| 相互作用チェック         | **行わない**（10節）                                                    |

---

## 10. 健康上の安全（実装仕様書 5.6節 / 10章）

> 相互作用や安全性の確定判断は行わず、必要時は専門家への相談を案内する。

- **サーバーは相互作用・過剰摂取の判定を一切しない。** 上限量の警告も出さない。
  API は利用者が入力した記録をそのまま保存する。
- `safetyNote`（安全上の注意）は**利用者が自分で書いたメモ**であり、サーバーが
  生成・検証した情報ではない。画面でもそのように見せること
  （「製品ラベルの注意書き」等のラベルを付ける）。
- 画面には、サプリメントは医療行為の代替ではないこと、体調に不安があるときは
  医師・薬剤師へ相談することを常設で案内する。
- 在庫の残量・期限は利用者の入力に基づく推定であり、実物と一致する保証はない。

---

## 11. 検証状況

| 種類                                    | 場所                                               |
| --------------------------------------- | -------------------------------------------------- |
| スキーマ契約・制約                      | `tests/db/supplements.test.ts`（36件）             |
| RLS 分離・SECURITY DEFINER の所有者検査 | `tests/db/supplements-rls.test.ts`（22件）         |
| **FEFO 消費・負在庫拒否・取消復元**     | `tests/db/supplements-fefo.test.ts`（19件）        |
| 冪等再送・409 からの復帰                | `tests/db/supplements-idempotency.test.ts`（15件） |
| API 境界・分岐・応答                    | `src/app/api/supplements/route.test.ts`（57件）    |
| 契約スキーマ単体                        | `src/features/supplements/schema.test.ts`          |
| 在庫計算・FEFO 並び順                   | `src/features/supplements/units.test.ts`           |

DB のテストは PGlite に全 migration を新規適用した実データベースへ、実リポジトリを
そのまま通して実行している（モックの台本ではない）。

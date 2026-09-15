// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SUPPLEMENT_CATEGORIES,
  SUPPLEMENT_FORMS,
  SUPPLEMENT_MEAL_RELATIONS,
  SUPPLEMENT_MOVEMENT_KINDS,
  SUPPLEMENT_SCHEDULE_KINDS,
  SUPPLEMENT_INTAKE_STATUSES,
  SUPPLEMENT_UNITS,
  normalizeSupplementName,
} from "@/features/supplements/units";

import { asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

/**
 * サプリメントのスキーマ契約（実装仕様書 5.6節 / 6.1〜6.4節）。
 *
 * PGlite へ全 migration を新規適用したうえで、
 *   - 共通テンプレート（row_version / client_mutation_id / 楽観ロック）の取り付け
 *   - 定義域（カテゴリ・剤形・単位・状態）と TypeScript 側の定数の一致
 *   - 実装仕様書 5.6節の値域・順序の制約
 *   - 名称正規化・stableKey の重複禁止
 *   - **負在庫を許さない CHECK 制約**
 *   - 服用記録・在庫の動きへの直接書き込みの禁止
 * を確認する。RLS 分離は `supplements-rls.test.ts`、FEFO と取消復元は
 * `supplements-fefo.test.ts`、冪等再送は `supplements-idempotency.test.ts`。
 */

const SUPPLEMENT_OWNED_TABLES = [
  "supplement_products",
  "supplement_schedules",
  "supplement_inventory_lots",
  "supplement_intake_logs",
] as const;

describe("サプリメントのスキーマ (実装仕様書 5.6節)", () => {
  let db: PGlite;
  let userId: string;
  let productId: string;

  const asUser = async <T>(run: () => Promise<T>): Promise<T> => asAuthenticated(db, userId, run);

  const createProduct = async (
    key: string,
    name: string,
    overrides: Partial<{ unit: string; archived: boolean }> = {},
  ): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.supplement_products
         (owner_id, product_key, name, category, form, default_amount, default_unit, archived_at)
       values ($1, $2, $3, 'vitamin', 'tablet', 1, $4, $5)
       returning id`,
      [
        userId,
        key,
        name,
        overrides.unit ?? "tablet",
        overrides.archived === true ? new Date() : null,
      ],
    );
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "supplements@example.test");
    productId = await asUser(async () => createProduct("vitamin_c", "ビタミンC"));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /* ------------------------------------------------------------------ */
  /* 共通テンプレート（docs/database/table-conventions.md）              */
  /* ------------------------------------------------------------------ */

  it("可変4テーブルすべてに共通テンプレートが取り付けられている", async () => {
    for (const table of SUPPLEMENT_OWNED_TABLES) {
      const { rows: indexes } = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = $1",
        [table],
      );
      expect(
        indexes.some((index) => index.indexname.endsWith("_owner_client_mutation_key")),
        `${table} に冪等性インデックスが無い`,
      ).toBe(true);

      const { rows: triggers } = await db.query<{ tgname: string }>(
        `select t.tgname from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where c.relname = $1 and not t.tgisinternal`,
        [table],
      );
      const names = triggers.map((trigger) => trigger.tgname);
      expect(names.some((name) => name.endsWith("_owned_before_insert"))).toBe(true);
      expect(names.some((name) => name.endsWith("_owned_before_update"))).toBe(true);
    }
  });

  it("(id, owner_id) の候補キーを全テーブルが持つ（複合外部キーの参照先）", async () => {
    for (const table of [...SUPPLEMENT_OWNED_TABLES, "supplement_inventory_movements"]) {
      const { rows } = await db.query<{ count: string }>(
        `select count(*)::text as count
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
          where c.relname = $1
            and con.contype in ('p', 'u')
            and (
              select array_agg(a.attname::text order by a.attname::text)
                from pg_attribute a
               where a.attrelid = con.conrelid and a.attnum = any (con.conkey)
            ) = array['id', 'owner_id']`,
        [table],
      );
      expect(Number(rows[0]?.count ?? 0), `${table} に (id, owner_id) が無い`).toBeGreaterThan(0);
    }
  });

  it("子テーブルは (product_id, owner_id) の複合外部キーで商品を参照する（6.2節）", async () => {
    for (const table of [
      "supplement_schedules",
      "supplement_inventory_lots",
      "supplement_intake_logs",
      "supplement_inventory_movements",
    ]) {
      const { rows } = await db.query<{ definition: string }>(
        `select pg_get_constraintdef(con.oid) as definition
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
          where c.relname = $1 and con.contype = 'f'`,
        [table],
      );
      expect(
        rows.some((row) =>
          row.definition.startsWith(
            "FOREIGN KEY (product_id, owner_id) REFERENCES supplement_products(id, owner_id)",
          ),
        ),
        `${table} に (product_id, owner_id) の複合外部キーが無い`,
      ).toBe(true);
    }
  });

  it("追記専用の supplement_inventory_movements には可変テンプレートを取り付けない", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'supplement_inventory_movements'`,
    );
    const columns = rows.map((row) => row.column_name);
    expect(columns).not.toContain("row_version");
    expect(columns).not.toContain("client_mutation_id");
    expect(columns).not.toContain("updated_at");
  });

  it("row_version はサーバーだけが進め、id / owner_id は変更できない", async () => {
    // クライアントは row_version 列にそもそも触れない（列レベル権限で剥奪済み）。
    const forged = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          `insert into public.supplement_products
             (owner_id, product_key, name, category, form, default_unit, row_version)
           values ($1, 'row_version_forge', '版番号偽装', 'other', 'other', 'piece', 999)`,
          [userId],
        ),
      ),
    );
    expect(forged).toContain("permission denied");

    const created = await asUser(async () =>
      db.query<{ id: string; row_version: string }>(
        `insert into public.supplement_products
           (owner_id, product_key, name, category, form, default_unit)
         values ($1, 'row_version_probe', '版番号検査用', 'other', 'other', 'piece')
         returning id, row_version::text`,
        [userId],
      ),
    );
    // INSERT トリガーが必ず 1 にする（実装仕様書 6.4節）。
    expect(created.rows[0]?.row_version).toBe("1");

    const updated = await asUser(async () =>
      db.query<{ row_version: string }>(
        "update public.supplement_products set name = '版番号検査用2' where id = $1 returning row_version::text",
        [created.rows[0]?.id],
      ),
    );
    expect(updated.rows[0]?.row_version).toBe("2");

    // 所有者の移し替えは列レベル権限の時点で止まる（UPDATE の列に owner_id が無い）。
    // 共通トリガー `tg_owned_mutable_before_update()` も同じ変更を 23514 で拒むが、
    // ここまで到達しない。トリガー単体の検証は tests/db/mutation-patterns.test.ts。
    const message = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          "update public.supplement_products set owner_id = gen_random_uuid() where id = $1",
          [created.rows[0]?.id],
        ),
      ),
    );
    expect(message).toContain("permission denied");
  });

  /* ------------------------------------------------------------------ */
  /* 定義域（TypeScript 側の定数と一致すること）                         */
  /* ------------------------------------------------------------------ */

  it.each([
    ["supplement_category_is_allowed", SUPPLEMENT_CATEGORIES],
    ["supplement_form_is_allowed", SUPPLEMENT_FORMS],
    ["supplement_unit_is_allowed", SUPPLEMENT_UNITS],
    ["supplement_schedule_kind_is_allowed", SUPPLEMENT_SCHEDULE_KINDS],
    ["supplement_meal_relation_is_allowed", SUPPLEMENT_MEAL_RELATIONS],
    ["supplement_intake_status_is_allowed", SUPPLEMENT_INTAKE_STATUSES],
    ["supplement_movement_kind_is_allowed", SUPPLEMENT_MOVEMENT_KINDS],
  ] as const)("定義域 %s が units.ts の定数と一致する", async (fn, values) => {
    for (const value of values) {
      const { rows } = await db.query<{ allowed: boolean }>(`select public.${fn}($1) as allowed`, [
        value,
      ]);
      expect(rows[0]?.allowed, `${fn}(${value}) が false`).toBe(true);
    }

    const { rows: unknownValue } = await db.query<{ allowed: boolean }>(
      `select public.${fn}('__not_a_real_value__') as allowed`,
    );
    expect(unknownValue[0]?.allowed).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /* 商品: 名称正規化と stableKey の重複禁止（実装仕様書 5.6節）        */
  /* ------------------------------------------------------------------ */

  it("名称は NFKC・空白畳み込み・小文字化して保存され、TypeScript 側と一致する", async () => {
    const source = "  Ｖｉｔａｍｉｎ　　Ｃ  ";
    const { rows } = await asUser(async () =>
      db.query<{ name_normalized: string }>(
        `insert into public.supplement_products
           (owner_id, product_key, name, category, form, default_unit)
         values ($1, 'normalize_probe', $2, 'vitamin', 'tablet', 'tablet')
         returning name_normalized`,
        [userId, source],
      ),
    );

    expect(rows[0]?.name_normalized).toBe("vitamin c");
    // フロントの事前チェック（units.ts）と DB の判定キーがずれていない。
    expect(normalizeSupplementName(source)).toBe(rows[0]?.name_normalized);
  });

  it("正規化後に同じ名称の商品は登録できない（全角・半角・大小・空白の違いを吸収する）", async () => {
    await asUser(async () => createProduct("dup_base", "マルチビタミン"));

    // 半角カタカナは NFKC で全角へ畳まれるので、同じ商品として扱われる。
    const halfWidth = await expectRejection(async () =>
      asUser(async () => createProduct("dup_half_width", "ﾏﾙﾁﾋﾞﾀﾐﾝ")),
    );
    expect(halfWidth).toContain("supplement_products_owner_name_key");

    await asUser(async () => createProduct("dup_latin", "Fish Oil"));

    // 大文字小文字・前後の空白・空白の連続も同一視する。
    const casing = await expectRejection(async () =>
      asUser(async () => createProduct("dup_latin_2", "  FISH   OIL  ")),
    );
    expect(casing).toContain("supplement_products_owner_name_key");
  });

  it("同じ stableKey（product_key）の商品は登録できない", async () => {
    await asUser(async () => createProduct("stable_key_probe", "スタブルキー検査A"));

    const message = await expectRejection(async () =>
      asUser(async () => createProduct("stable_key_probe", "スタブルキー検査B")),
    );
    expect(message).toContain("supplement_products_owner_key_key");
  });

  it("空白だけの名称は拒否される（重複判定が成り立たないため）", async () => {
    const message = await expectRejection(async () =>
      asUser(async () => createProduct("blank_name_probe", "  　  ")),
    );
    expect(message).toContain("supplement_products_name_not_blank");
  });

  it("URL は https のみ許可される（実装仕様書 5.6節）", async () => {
    for (const url of ["http://example.com", "javascript:alert(1)", "example.com"]) {
      const message = await expectRejection(async () =>
        asUser(async () =>
          db.query(
            `insert into public.supplement_products
               (owner_id, product_key, name, category, form, default_unit, url)
             values ($1, 'url_probe_' || md5($2), $2, 'other', 'other', 'piece', $2)`,
            [userId, url],
          ),
        ),
      );
      expect(message).toContain("supplement_products_url_https");
    }

    const ok = await asUser(async () =>
      db.query<{ url: string }>(
        `insert into public.supplement_products
           (owner_id, product_key, name, category, form, default_unit, url)
         values ($1, 'url_ok', 'URL検査', 'other', 'other', 'piece', 'https://example.com/a')
         returning url`,
        [userId],
      ),
    );
    expect(ok.rows[0]?.url).toBe("https://example.com/a");
  });

  /* ------------------------------------------------------------------ */
  /* 摂取予定（実装仕様書 5.6節）                                        */
  /* ------------------------------------------------------------------ */

  const insertSchedule = async (
    kind: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> => {
    await asUser(async () =>
      db.query(
        `insert into public.supplement_schedules
           (owner_id, product_id, schedule_kind, time_of_day, weekdays, start_date, end_date, amount, unit)
         values ($1, $2, $3, $4, $5, $6, $7, 1, 'tablet')`,
        [
          userId,
          productId,
          kind,
          // `??` だと明示的に渡した null が既定値へ戻ってしまうので、キーの有無で見る。
          "time_of_day" in overrides
            ? overrides["time_of_day"]
            : kind === "as_needed"
              ? null
              : "08:00",
          "weekdays" in overrides ? overrides["weekdays"] : kind === "weekly" ? [1, 3, 5] : null,
          overrides["start_date"] ?? "2026-09-01",
          overrides["end_date"] ?? null,
        ],
      ),
    );
  };

  it("週次の予定は曜日が必須で、それ以外の種別は曜日を持てない", async () => {
    const missing = await expectRejection(async () =>
      insertSchedule("weekly", { weekdays: null, start_date: "2026-09-02" }),
    );
    expect(missing).toContain("supplement_schedules_weekdays_for_weekly");

    const unexpected = await expectRejection(async () =>
      insertSchedule("daily", { weekdays: [1], start_date: "2026-09-03" }),
    );
    expect(unexpected).toContain("supplement_schedules_weekdays_for_weekly");

    await insertSchedule("weekly", { start_date: "2026-09-04" });
  });

  it("曜日は 0〜6・1〜7件・重複なし（実装仕様書 5.6節）", async () => {
    for (const weekdays of [[], [7], [-1], [1, 1]]) {
      const message = await expectRejection(async () =>
        insertSchedule("weekly", { weekdays, start_date: "2026-09-05" }),
      );
      expect(message).toContain("supplement_schedules_weekdays_for_weekly");
    }
  });

  it("必要時の予定は時刻を持たず、それ以外の種別は時刻が必須", async () => {
    const withTime = await expectRejection(async () =>
      insertSchedule("as_needed", { time_of_day: "09:00", start_date: "2026-09-06" }),
    );
    expect(withTime).toContain("supplement_schedules_time_for_kind");

    const withoutTime = await expectRejection(async () =>
      insertSchedule("daily", { time_of_day: null, start_date: "2026-09-07" }),
    );
    expect(withoutTime).toContain("supplement_schedules_time_for_kind");

    await insertSchedule("as_needed", { start_date: "2026-09-08" });
  });

  it("終了日は開始日以降でなければならない（実装仕様書 5.6節）", async () => {
    const message = await expectRejection(async () =>
      insertSchedule("daily", { start_date: "2026-09-10", end_date: "2026-09-09" }),
    );
    expect(message).toContain("supplement_schedules_end_after_start");
  });

  it("単発の予定は1日で完結する", async () => {
    const message = await expectRejection(async () =>
      insertSchedule("once", { start_date: "2026-09-11", end_date: "2026-09-12" }),
    );
    expect(message).toContain("supplement_schedules_once_single_day");

    await insertSchedule("once", { start_date: "2026-09-13", end_date: "2026-09-13" });
  });

  /* ------------------------------------------------------------------ */
  /* 在庫ロット: 負在庫を許さない不変条件（実装仕様書 5.6節）           */
  /* ------------------------------------------------------------------ */

  const insertLot = async (
    product: string,
    quantity: number,
    remaining: number,
    unit = "tablet",
  ): Promise<string> => {
    const { rows } = await asUser(async () =>
      db.query<{ id: string }>(
        `insert into public.supplement_inventory_lots
           (owner_id, product_id, quantity, remaining_quantity, unit)
         values ($1, $2, $3, $4, $5) returning id`,
        [userId, product, quantity, remaining, unit],
      ),
    );
    return rows[0]?.id ?? "";
  };

  it("残量が負になる操作は CHECK 制約が拒否する（RPC を通らない経路でも）", async () => {
    const lotId = await insertLot(productId, 10, 10);

    const direct = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          "update public.supplement_inventory_lots set remaining_quantity = -1 where id = $1",
          [lotId],
        ),
      ),
    );
    expect(direct).toContain("supplement_inventory_lots_remaining_not_negative");

    const onInsert = await expectRejection(async () => insertLot(productId, 5, -0.0001));
    expect(onInsert).toContain("supplement_inventory_lots_remaining_not_negative");
  });

  it("残量はロットの初期数量を超えられない（在庫の水増しを防ぐ）", async () => {
    const lotId = await insertLot(productId, 10, 10);

    const message = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          "update public.supplement_inventory_lots set remaining_quantity = 11 where id = $1",
          [lotId],
        ),
      ),
    );
    expect(message).toContain("supplement_inventory_lots_remaining_within_quantity");
  });

  it("ロットの単位は商品の既定単位に揃わなければならない", async () => {
    const message = await expectRejection(async () => insertLot(productId, 10, 10, "mg"));
    expect(message).toContain("must match the supplement product default unit");
  });

  it("アーカイブ済み商品には新しいロット・予定を登録できない（既存行の訂正は可）", async () => {
    const archived = await asUser(async () =>
      createProduct("archived_probe", "アーカイブ検査", { archived: true }),
    );

    const lotMessage = await expectRejection(async () => insertLot(archived, 5, 5));
    expect(lotMessage).toContain("is archived");

    const scheduleMessage = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          `insert into public.supplement_schedules
             (owner_id, product_id, schedule_kind, time_of_day, start_date, amount, unit)
           values ($1, $2, 'daily', '08:00', '2026-09-01', 1, 'tablet')`,
          [userId, archived],
        ),
      ),
    );
    expect(scheduleMessage).toContain("is archived");
  });

  it("使用期限・開封日は購入日以降でなければならない", async () => {
    const message = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          `insert into public.supplement_inventory_lots
             (owner_id, product_id, quantity, remaining_quantity, unit, purchased_on, expires_on)
           values ($1, $2, 5, 5, 'tablet', '2026-09-10', '2026-09-01')`,
          [userId, productId],
        ),
      ),
    );
    expect(message).toContain("supplement_inventory_lots_expires_after_purchase");
  });

  it("同じ lot_code の2件目は拒否され、lot_code 無しは何件でも登録できる", async () => {
    const product = await asUser(async () => createProduct("lot_code_probe", "ロット名検査"));

    await asUser(async () =>
      db.query(
        `insert into public.supplement_inventory_lots
           (owner_id, product_id, lot_code, quantity, remaining_quantity, unit)
         values ($1, $2, 'L-001', 5, 5, 'tablet')`,
        [userId, product],
      ),
    );

    const message = await expectRejection(async () =>
      asUser(async () =>
        db.query(
          `insert into public.supplement_inventory_lots
             (owner_id, product_id, lot_code, quantity, remaining_quantity, unit)
           values ($1, $2, 'L-001', 9, 9, 'tablet')`,
          [userId, product],
        ),
      ),
    );
    expect(message).toContain("supplement_inventory_lots_owner_code_key");

    // NULL 同士は衝突しない（部分一意インデックス）。
    await asUser(async () =>
      db.query(
        `insert into public.supplement_inventory_lots
           (owner_id, product_id, quantity, remaining_quantity, unit)
         values ($1, $2, 3, 3, 'tablet'), ($1, $2, 4, 4, 'tablet')`,
        [userId, product],
      ),
    );
  });

  /* ------------------------------------------------------------------ */
  /* 在庫の動き（監査証跡）                                              */
  /* ------------------------------------------------------------------ */

  it("ロットの登録と手動調整が在庫の動きへ自動で記録される", async () => {
    const product = await asUser(async () => createProduct("movement_probe", "動き検査"));
    const lotId = await insertLot(product, 10, 10);

    await asUser(async () =>
      db.query("update public.supplement_inventory_lots set remaining_quantity = 7 where id = $1", [
        lotId,
      ]),
    );
    // 残量が動かない更新は在庫の動きではない。
    await asUser(async () =>
      db.query("update public.supplement_inventory_lots set note = 'メモ' where id = $1", [lotId]),
    );

    const { rows } = await asUser(async () =>
      db.query<{ movement_kind: string; quantity_delta: string; intake_log_id: string | null }>(
        `select movement_kind, quantity_delta::text, intake_log_id
           from public.supplement_inventory_movements
          where lot_id = $1 order by created_at, id`,
        [lotId],
      ),
    );

    expect(rows.map((row) => [row.movement_kind, Number(row.quantity_delta)])).toStrictEqual([
      ["purchase", 10],
      ["adjustment", -3],
    ]);
    expect(rows.every((row) => row.intake_log_id === null)).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* 服用記録・在庫の動きの偽装防止（実装仕様書 9.2節）                  */
  /* ------------------------------------------------------------------ */

  it("服用記録は authenticated から直接書けない（原子的RPCだけが書き手）", async () => {
    for (const statement of [
      `insert into public.supplement_intake_logs
         (owner_id, product_id, status, recorded_at, amount, unit, consumed_quantity, idempotency_key)
       values ('${userId}', '${productId}', 'taken', now(), 1, 'tablet', 0, 'forged-key-1')`,
      `update public.supplement_intake_logs set consumed_quantity = 0`,
      `delete from public.supplement_intake_logs`,
    ]) {
      const message = await expectRejection(async () => asUser(async () => db.query(statement)));
      expect(message).toContain("permission denied");
    }
  });

  it("在庫の動きは authenticated から直接書けない（トリガーだけが書き手）", async () => {
    for (const statement of [
      `insert into public.supplement_inventory_movements
         (owner_id, product_id, lot_id, movement_kind, quantity_delta, unit)
       values ('${userId}', '${productId}', gen_random_uuid(), 'intake_void_restore', 99, 'tablet')`,
      `update public.supplement_inventory_movements set quantity_delta = 0`,
      `delete from public.supplement_inventory_movements`,
    ]) {
      const message = await expectRejection(async () => asUser(async () => db.query(statement)));
      expect(message).toContain("permission denied");
    }
  });

  it("商品は削除できない（アーカイブで無効化する）", async () => {
    const message = await expectRejection(async () =>
      asUser(async () =>
        db.query("delete from public.supplement_products where id = $1", [productId]),
      ),
    );
    expect(message).toContain("permission denied");
  });

  it("stableKey（product_key）は作成後に変更できない（列レベル権限）", async () => {
    const message = await expectRejection(async () =>
      asUser(async () =>
        db.query("update public.supplement_products set product_key = 'renamed' where id = $1", [
          productId,
        ]),
      ),
    );
    expect(message).toContain("permission denied");
  });
});

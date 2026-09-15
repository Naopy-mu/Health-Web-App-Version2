// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

/**
 * サプリメント6テーブルの RLS 分離（実装仕様書 5.6節 / 6.5節 / 9章）。
 *
 * docs/database/table-conventions.md 4節のとおり、所有者条件に加えて
 * `public.is_active_user()` を要求する。匿名は全操作を拒否する。
 *
 * サプリメント固有の確認:
 *   - 原子的RPC（`record_supplement_intake` / `void_supplement_intake`）は
 *     SECURITY DEFINER で RLS を迂回するため、**関数の中で所有者を検査している**
 *     ことを他利用者の商品・記録に対して確かめる
 *   - 服用記録・在庫の動きは所有者本人でも SELECT しか通らない
 *   - 他利用者の商品へ子（予定・ロット）を接続できない（複合外部キー）
 */
describe("サプリメントの RLS 分離 (実装仕様書 6.5節 / 9章)", () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let aliceProduct: string;
  let bobProduct: string;
  let aliceLot: string;
  let aliceSchedule: string;
  let aliceIntake: string;

  const createProduct = async (userId: string, key: string, name: string): Promise<string> => {
    const { rows } = await asAuthenticated(db, userId, async () =>
      db.query<{ id: string }>(
        `insert into public.supplement_products
           (owner_id, product_key, name, category, form, default_amount, default_unit)
         values ($1, $2, $3, 'vitamin', 'tablet', 1, 'tablet') returning id`,
        [userId, key, name],
      ),
    );
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    db = await createMigratedDatabase();
    alice = await signUp(db, "supplements-rls-alice@example.test");
    bob = await signUp(db, "supplements-rls-bob@example.test");

    aliceProduct = await createProduct(alice, "alice_vitamin", "アリスのビタミン");
    bobProduct = await createProduct(bob, "bob_vitamin", "ボブのビタミン");

    const lot = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.supplement_inventory_lots
           (owner_id, product_id, lot_code, quantity, remaining_quantity, unit, expires_on)
         values ($1, $2, 'A-1', 10, 10, 'tablet', '2027-01-31') returning id`,
        [alice, aliceProduct],
      ),
    );
    aliceLot = lot.rows[0]?.id ?? "";

    const schedule = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.supplement_schedules
           (owner_id, product_id, schedule_kind, time_of_day, start_date, amount, unit)
         values ($1, $2, 'daily', '08:00', '2026-09-01', 1, 'tablet') returning id`,
        [alice, aliceProduct],
      ),
    );
    aliceSchedule = schedule.rows[0]?.id ?? "";

    const intake = await asAuthenticated(db, alice, async () =>
      db.query<{ record_supplement_intake: { intake: { id: string } } }>(
        `select public.record_supplement_intake(
           p_product_id => $1, p_idempotency_key => 'alice-intake-0001',
           p_recorded_at => timestamptz '2026-09-15T09:00:00Z', p_amount => 2)
         as record_supplement_intake`,
        [aliceProduct],
      ),
    );
    aliceIntake = intake.rows[0]?.record_supplement_intake.intake.id ?? "";
    expect(aliceIntake).not.toBe("");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /* ------------------------------------------------------------------ */
  /* 匿名アクセス                                                        */
  /* ------------------------------------------------------------------ */

  it.each([
    "supplement_products",
    "supplement_schedules",
    "supplement_inventory_lots",
    "supplement_intake_logs",
    "supplement_inventory_movements",
    "supplement_mutation_log",
  ])("匿名は %s を読めない（SELECT 権限そのものが無い）", async (table) => {
    const message = await expectRejection(async () =>
      asAnon(db, async () => db.query(`select * from public.${table}`)),
    );
    expect(message, `${table} が anon から読めてしまう`).toContain("permission denied");
  });

  it("匿名は商品を作れない", async () => {
    const message = await expectRejection(async () =>
      asAnon(db, async () =>
        db.query(
          `insert into public.supplement_products
             (owner_id, product_key, name, category, form, default_unit)
           values ($1, 'anon_probe', '匿名', 'other', 'other', 'piece')`,
          [alice],
        ),
      ),
    );
    expect(message).toContain("permission denied");
  });

  it("匿名は原子的RPCを実行できない", async () => {
    const message = await expectRejection(async () =>
      asAnon(db, async () =>
        db.query(
          `select public.record_supplement_intake(
             p_product_id => $1, p_idempotency_key => 'anon-intake-01',
             p_recorded_at => now())`,
          [aliceProduct],
        ),
      ),
    );
    expect(message).toContain("permission denied");
  });

  /* ------------------------------------------------------------------ */
  /* 所有者どうしの分離                                                  */
  /* ------------------------------------------------------------------ */

  it.each([
    ["supplement_products", () => aliceProduct],
    ["supplement_schedules", () => aliceSchedule],
    ["supplement_inventory_lots", () => aliceLot],
    ["supplement_intake_logs", () => aliceIntake],
  ] as const)("Bob は Alice の %s の行を読めない", async (table, idOf) => {
    const { rows } = await asAuthenticated(db, bob, async () =>
      db.query<{ count: string }>(
        `select count(*)::text as count from public.${table} where id = $1`,
        [idOf()],
      ),
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("Bob は Alice の在庫の動きを読めない", async () => {
    const { rows } = await asAuthenticated(db, bob, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.supplement_inventory_movements where lot_id = $1",
        [aliceLot],
      ),
    );
    expect(rows[0]?.count).toBe("0");

    // Alice 本人からは見える。
    const mine = await asAuthenticated(db, alice, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.supplement_inventory_movements where lot_id = $1",
        [aliceLot],
      ),
    );
    expect(Number(mine.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("Bob は Alice の商品を更新・アーカイブできない", async () => {
    const { rows } = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>(
        "update public.supplement_products set archived_at = now() where id = $1 returning id",
        [aliceProduct],
      ),
    );
    expect(rows).toHaveLength(0);

    const check = await asAuthenticated(db, alice, async () =>
      db.query<{ archived_at: Date | null }>(
        "select archived_at from public.supplement_products where id = $1",
        [aliceProduct],
      ),
    );
    expect(check.rows[0]?.archived_at).toBeNull();
  });

  it("Bob は Alice の在庫ロットの残量を動かせない", async () => {
    const { rows } = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>(
        "update public.supplement_inventory_lots set remaining_quantity = 0 where id = $1 returning id",
        [aliceLot],
      ),
    );
    expect(rows).toHaveLength(0);

    const check = await asAuthenticated(db, alice, async () =>
      db.query<{ remaining_quantity: string }>(
        "select remaining_quantity::text from public.supplement_inventory_lots where id = $1",
        [aliceLot],
      ),
    );
    expect(Number(check.rows[0]?.remaining_quantity)).toBe(8);
  });

  it("Bob は Alice の予定・ロットを削除できない", async () => {
    for (const [table, id] of [
      ["supplement_schedules", aliceSchedule],
      ["supplement_inventory_lots", aliceLot],
    ] as const) {
      const { rows } = await asAuthenticated(db, bob, async () =>
        db.query<{ id: string }>(`delete from public.${table} where id = $1 returning id`, [id]),
      );
      expect(rows, `${table} が他利用者から削除された`).toHaveLength(0);
    }
  });

  /* ------------------------------------------------------------------ */
  /* 複合外部キー（実装仕様書 6.2節）                                    */
  /* ------------------------------------------------------------------ */

  it("他利用者の商品へ予定・ロットを接続できない（複合外部キー）", async () => {
    const schedule = await expectRejection(async () =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.supplement_schedules
             (owner_id, product_id, schedule_kind, time_of_day, start_date, amount, unit)
           values ($1, $2, 'daily', '08:00', '2026-09-01', 1, 'tablet')`,
          [bob, aliceProduct],
        ),
      ),
    );
    expect(schedule).toContain("supplement product not found for owner");

    const lot = await expectRejection(async () =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.supplement_inventory_lots
             (owner_id, product_id, quantity, remaining_quantity, unit)
           values ($1, $2, 5, 5, 'tablet')`,
          [bob, aliceProduct],
        ),
      ),
    );
    expect(lot).toContain("supplement product not found for owner");
  });

  /* ------------------------------------------------------------------ */
  /* SECURITY DEFINER の RPC が所有者を検査していること                  */
  /* ------------------------------------------------------------------ */

  it("原子的RPCは他利用者の商品への服用を拒否する（RLS を迂回するため関数内で検査）", async () => {
    const message = await expectRejection(async () =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `select public.record_supplement_intake(
             p_product_id => $1, p_idempotency_key => 'bob-steals-01',
             p_recorded_at => now(), p_amount => 1)`,
          [aliceProduct],
        ),
      ),
    );
    expect(message).toContain("supplement product not found for owner");

    // Alice の在庫は動いていない。
    const check = await asAuthenticated(db, alice, async () =>
      db.query<{ remaining_quantity: string }>(
        "select remaining_quantity::text from public.supplement_inventory_lots where id = $1",
        [aliceLot],
      ),
    );
    expect(Number(check.rows[0]?.remaining_quantity)).toBe(8);
  });

  it("原子的RPCは他利用者の服用記録の取消を拒否する（0件＝competing conflict）", async () => {
    const { rows } = await asAuthenticated(db, bob, async () =>
      db.query<{ void_supplement_intake: { outcome: string } }>(
        "select public.void_supplement_intake(p_id => $1) as void_supplement_intake",
        [aliceIntake],
      ),
    );
    // 他利用者の記録は「見えない」ので conflict（存在の有無は漏らさない）。
    expect(rows[0]?.void_supplement_intake.outcome).toBe("conflict");

    // Alice の記録も在庫も変わっていない。
    const check = await asAuthenticated(db, alice, async () =>
      db.query<{ status: string; remaining: string }>(
        `select l.status,
                (select remaining_quantity::text from public.supplement_inventory_lots where id = $2) as remaining
           from public.supplement_intake_logs l where l.id = $1`,
        [aliceIntake, aliceLot],
      ),
    );
    expect(check.rows[0]?.status).toBe("taken");
    expect(Number(check.rows[0]?.remaining)).toBe(8);
  });

  it("集計 RPC は自分のデータだけを数える", async () => {
    const aliceSummary = await asAuthenticated(db, alice, async () =>
      db.query<{ weekly_scheduled_count: number; low_stock_product_count: number }>(
        `select * from public.supplement_summary(
           p_reference => timestamptz '2026-09-15T12:00:00Z')`,
      ),
    );
    expect(Number(aliceSummary.rows[0]?.weekly_scheduled_count)).toBeGreaterThan(0);

    const bobSummary = await asAuthenticated(db, bob, async () =>
      db.query<{ weekly_scheduled_count: number }>(
        `select * from public.supplement_summary(
           p_reference => timestamptz '2026-09-15T12:00:00Z')`,
      ),
    );
    expect(Number(bobSummary.rows[0]?.weekly_scheduled_count)).toBe(0);
  });

  it("在庫要約 RPC は自分の商品だけを返す", async () => {
    const { rows } = await asAuthenticated(db, bob, async () =>
      db.query<{ product_id: string }>("select * from public.supplement_product_stock()"),
    );
    expect(rows.map((row) => row.product_id)).toStrictEqual([bobProduct]);
  });

  /* ------------------------------------------------------------------ */
  /* 利用者状態（実装仕様書 6.5節: active 以外は全操作から排除）         */
  /* ------------------------------------------------------------------ */

  it("active でない利用者は自分の行すら読めず、RPC も実行できない", async () => {
    await db.query("update public.users set status = 'suspended' where id = $1", [alice]);

    try {
      const { rows } = await asAuthenticated(db, alice, async () =>
        db.query<{ count: string }>(
          "select count(*)::text as count from public.supplement_products where id = $1",
          [aliceProduct],
        ),
      );
      expect(rows[0]?.count).toBe("0");

      const message = await expectRejection(async () =>
        asAuthenticated(db, alice, async () =>
          db.query(
            `select public.record_supplement_intake(
               p_product_id => $1, p_idempotency_key => 'suspended-01',
               p_recorded_at => now(), p_amount => 1)`,
            [aliceProduct],
          ),
        ),
      );
      expect(message).toContain("account is not active");
    } finally {
      await db.query("update public.users set status = 'active' where id = $1", [alice]);
    }
  });
});

// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

/**
 * 睡眠・水分・体調8テーブルの RLS 分離（実装仕様書 5.5節 / 6.5節 / 9章）。
 *
 * docs/database/table-conventions.md 4節のとおり、所有者条件に加えて
 * `public.is_active_user()` を要求する。匿名は全操作を拒否する。
 */
describe("睡眠・水分・体調の RLS 分離 (実装仕様書 6.5節 / 9章)", () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let aliceWater: string;
  let bobWater: string;
  let aliceHeadache: string;
  let aliceSleepEntry: string;
  let aliceHydrationEntry: string;
  let aliceConditionEntry: string;
  let aliceSleepGoal: string;

  const typeIdOf = async (table: string, column: string, userId: string, key: string) => {
    const { rows } = await db.query<{ id: string }>(
      `select id from public.${table} where owner_id = $1 and ${column} = $2`,
      [userId, key],
    );
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    db = await createMigratedDatabase();
    alice = await signUp(db, "wellness-rls-alice@example.test");
    bob = await signUp(db, "wellness-rls-bob@example.test");

    for (const userId of [alice, bob]) {
      await asAuthenticated(db, userId, async () => {
        await db.query("select public.seed_default_beverage_types()");
        await db.query("select public.seed_default_symptom_types()");
      });
    }

    aliceWater = await typeIdOf("beverage_types", "beverage_key", alice, "water");
    bobWater = await typeIdOf("beverage_types", "beverage_key", bob, "water");
    aliceHeadache = await typeIdOf("symptom_types", "symptom_key", alice, "headache");

    const sleep = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.sleep_entries
           (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at)
         values ($1, 'night', timestamptz '2026-07-01T22:00:00Z', timestamptz '2026-07-01T22:30:00Z',
                 timestamptz '2026-07-02T06:00:00Z', timestamptz '2026-07-02T06:15:00Z')
         returning id`,
        [alice],
      ),
    );
    aliceSleepEntry = sleep.rows[0]?.id ?? "";

    const hydration = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.hydration_entries
           (owner_id, beverage_type_id, recorded_at, unit, amount)
         values ($1, $2, timestamptz '2026-07-01T09:00:00Z', 'ml', 200) returning id`,
        [alice, aliceWater],
      ),
    );
    aliceHydrationEntry = hydration.rows[0]?.id ?? "";

    const condition = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.condition_entries (owner_id, recorded_at, overall_score)
         values ($1, timestamptz '2026-07-01T08:00:00Z', 7) returning id`,
        [alice],
      ),
    );
    aliceConditionEntry = condition.rows[0]?.id ?? "";

    await asAuthenticated(db, alice, async () =>
      db.query(
        `insert into public.condition_entry_symptoms (owner_id, entry_id, symptom_type_id)
         values ($1, $2, $3)`,
        [alice, aliceConditionEntry, aliceHeadache],
      ),
    );

    const goal = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date)
         values ($1, 420, date '2026-07-01') returning id`,
        [alice],
      ),
    );
    aliceSleepGoal = goal.rows[0]?.id ?? "";

    await asAuthenticated(db, bob, async () => {
      await db.query(
        `insert into public.hydration_entries
           (owner_id, beverage_type_id, recorded_at, unit, amount)
         values ($1, $2, timestamptz '2026-07-01T09:00:00Z', 'ml', 500)`,
        [bob, bobWater],
      );
      await db.query(
        `insert into public.hydration_goals (owner_id, target_amount_ml, start_date)
         values ($1, 2000, date '2026-07-01')`,
        [bob],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const ALL_TABLES = [
    "beverage_types",
    "symptom_types",
    "sleep_entries",
    "sleep_goals",
    "hydration_entries",
    "hydration_goals",
    "condition_entries",
    "condition_entry_symptoms",
    "wellness_mutation_log",
  ] as const;

  it("全テーブルで RLS が有効になっている", async () => {
    for (const table of ALL_TABLES) {
      const { rows } = await db.query<{ relrowsecurity: boolean }>(
        "select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace",
        [table],
      );
      expect(rows[0]?.relrowsecurity, `${table} の RLS が無効`).toBe(true);
    }
  });

  it("全ポリシーが public.is_active_user() を要求する（実装仕様書 6.5節）", async () => {
    const { rows } = await db.query<{ tablename: string; policyname: string; expr: string }>(
      `select tablename, policyname,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
         from pg_policies
        where schemaname = 'public' and tablename = any($1)`,
      [[...ALL_TABLES]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.expr, `${row.tablename}.${row.policyname}`).toContain("is_active_user");
      expect(row.expr, `${row.tablename}.${row.policyname}`).toContain("auth.uid()");
    }
  });

  it("匿名（anon）は全テーブルを読めない", async () => {
    for (const table of ALL_TABLES) {
      const message = await expectRejection(() =>
        asAnon(db, async () => db.query(`select * from public.${table}`)),
      );
      expect(message, `${table} が anon から読めてしまう`).toContain("permission denied");
    }
  });

  it("他人の記録は見えない", async () => {
    const seen = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>("select id from public.sleep_entries"),
    );
    expect(seen.rows.map((row) => row.id)).not.toContain(aliceSleepEntry);

    const hydration = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>("select id from public.hydration_entries"),
    );
    expect(hydration.rows.map((row) => row.id)).not.toContain(aliceHydrationEntry);

    const condition = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>("select id from public.condition_entries"),
    );
    expect(condition.rows.map((row) => row.id)).not.toContain(aliceConditionEntry);
  });

  it("他人の記録は更新・削除できない（0件更新になる）", async () => {
    const updated = await asAuthenticated(db, bob, async () =>
      db.query("update public.condition_entries set overall_score = 0 where id = $1", [
        aliceConditionEntry,
      ]),
    );
    expect(updated.affectedRows).toBe(0);

    const deleted = await asAuthenticated(db, bob, async () =>
      db.query("delete from public.sleep_goals where id = $1", [aliceSleepGoal]),
    );
    expect(deleted.affectedRows).toBe(0);
  });

  it("他人を所有者にした行は作れない（WITH CHECK）", async () => {
    const message = await expectRejection(() =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.condition_entries (owner_id, recorded_at)
           values ($1, timestamptz '2026-07-05T08:00:00Z')`,
          [alice],
        ),
      ),
    );
    expect(message).toContain("row-level security");
  });

  it("他人の体調記録へ症状を紐づけられない（複合外部キー）", async () => {
    const message = await expectRejection(() =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.condition_entry_symptoms (owner_id, entry_id, symptom_type_id)
           values ($1, $2, $3)`,
          [
            bob,
            aliceConditionEntry,
            await typeIdOf("symptom_types", "symptom_key", bob, "headache"),
          ],
        ),
      ),
    );
    // 親が (id, owner_id) で一致しないため、外部キーが成立しない。
    expect(message).toContain("condition_entry_symptoms_entry_fkey");
  });

  it("他人の飲み物種別へ水分記録を接続できない（複合外部キー）", async () => {
    const message = await expectRejection(() =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.hydration_entries
             (owner_id, beverage_type_id, recorded_at, unit, amount)
           values ($1, $2, timestamptz '2026-07-06T09:00:00Z', 'ml', 100)`,
          [bob, aliceWater],
        ),
      ),
    );
    // トリガーが所有者スコープで種別を引けず 23503 を投げる（外部キーも同じ形を拒否する）。
    expect(message).toContain("beverage type not found for owner");
  });

  it("種別カタログは DELETE 権限を持たない（アーカイブのみ）", async () => {
    for (const table of ["beverage_types", "symptom_types"]) {
      const message = await expectRejection(() =>
        asAuthenticated(db, alice, async () =>
          db.query(`delete from public.${table} where owner_id = $1`, [alice]),
        ),
      );
      expect(message, `${table} が削除できてしまう`).toContain("permission denied");
    }
  });

  it("冪等キーのログは読み取り専用（書き換えると偽の再送応答を作れてしまう）", async () => {
    const statements: readonly (readonly [string, unknown[]])[] = [
      [
        `insert into public.wellness_mutation_log
           (owner_id, resource, client_mutation_id, entity_id, operation, snapshot)
         values ($1, 'sleep_entries', gen_random_uuid(), gen_random_uuid(), 'insert', '{}'::jsonb)`,
        [alice],
      ],
      ["update public.wellness_mutation_log set snapshot = '{}'::jsonb", []],
      ["delete from public.wellness_mutation_log", []],
    ];

    for (const [statement, params] of statements) {
      const message = await expectRejection(() =>
        asAuthenticated(db, alice, async () => db.query(statement, [...params])),
      );
      expect(message).toContain("permission denied");
    }
  });

  it("非 active な利用者は自分のデータも読めない（実装仕様書 5.1節 / 6.5節）", async () => {
    const suspended = await signUp(db, "wellness-suspended@example.test");
    await asAuthenticated(db, suspended, async () =>
      db.query("select public.seed_default_beverage_types()"),
    );

    await db.query("update public.users set status = 'suspended' where id = $1", [suspended]);

    const seen = await asAuthenticated(db, suspended, async () =>
      db.query("select * from public.beverage_types"),
    );
    expect(seen.rows).toHaveLength(0);

    const message = await expectRejection(() =>
      asAuthenticated(db, suspended, async () =>
        db.query(
          `insert into public.condition_entries (owner_id, recorded_at)
           values ($1, now())`,
          [suspended],
        ),
      ),
    );
    expect(message).toContain("row-level security");
  });

  it("非 active な利用者は seed RPC も呼べない", async () => {
    const pending = await signUp(db, "wellness-pending@example.test");
    await db.query("update public.users set status = 'deletion_pending' where id = $1", [pending]);

    const message = await expectRejection(() =>
      asAuthenticated(db, pending, async () =>
        db.query("select public.seed_default_symptom_types()"),
      ),
    );
    expect(message).toContain("account is not active");
  });

  it("利用者を削除すると睡眠・水分・体調のデータも消える（CASCADE）", async () => {
    const doomed = await signUp(db, "wellness-doomed@example.test");
    await asAuthenticated(db, doomed, async () => {
      await db.query("select public.seed_default_beverage_types()");
      await db.query(
        `insert into public.condition_entries (owner_id, recorded_at)
         values ($1, timestamptz '2026-07-07T08:00:00Z')`,
        [doomed],
      );
    });

    await db.query("delete from auth.users where id = $1", [doomed]);

    for (const table of ["beverage_types", "condition_entries"]) {
      const { rows } = await db.query<{ count: string }>(
        `select count(*)::text as count from public.${table} where owner_id = $1`,
        [doomed],
      );
      expect(rows[0]?.count, `${table} が残っている`).toBe("0");
    }
  });
});

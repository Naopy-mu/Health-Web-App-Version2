// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

/**
 * 身体測定3テーブルの RLS 分離（実装仕様書 5.3節 / 6.5節 / 9章）。
 *
 * docs/database/table-conventions.md 4節のとおり、所有者条件に加えて
 * `public.is_active_user()` を要求する。匿名は全操作を拒否する。
 */
describe("身体測定の RLS 分離 (実装仕様書 6.5節 / 9章)", () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let aliceWeightType: string;
  let bobWeightType: string;
  let aliceMeasurement: string;

  const weightTypeOf = async (userId: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.body_measurement_types where owner_id = $1 and measurement_key = 'weight'",
      [userId],
    );
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    db = await createMigratedDatabase();
    alice = await signUp(db, "rls-alice@example.test");
    bob = await signUp(db, "rls-bob@example.test");

    for (const userId of [alice, bob]) {
      await asAuthenticated(db, userId, async () =>
        db.query("select public.seed_default_body_measurement_types()"),
      );
    }

    aliceWeightType = await weightTypeOf(alice);
    bobWeightType = await weightTypeOf(bob);

    const created = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
         values ($1, $2, timestamptz '2026-07-01T00:00:00Z', 62, 'kg') returning id`,
        [alice, aliceWeightType],
      ),
    );
    aliceMeasurement = created.rows[0]?.id ?? "";

    await asAuthenticated(db, bob, async () =>
      db.query(
        `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
         values ($1, $2, timestamptz '2026-07-01T00:00:00Z', 70, 'kg')`,
        [bob, bobWeightType],
      ),
    );

    await asAuthenticated(db, bob, async () =>
      db.query(
        `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
         values ($1, $2, 66, 'kg')`,
        [bob, bobWeightType],
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it.each(["body_measurement_types", "body_measurements", "body_measurement_goals"])(
    "%s で RLS が有効になっている",
    async (table) => {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
        [`public.${table}`],
      );
      expect(rows[0]?.relrowsecurity).toBe(true);
    },
  );

  it("anon には権限が無い（既定拒否）", async () => {
    for (const table of ["body_measurement_types", "body_measurements", "body_measurement_goals"]) {
      const message = await expectRejection(() =>
        asAnon(db, async () => db.query(`select * from public.${table}`)),
      );
      expect(message, table).toMatch(/permission denied/i);
    }
  });

  it("自分の測定記録だけが見える", async () => {
    const visible = await asAuthenticated(db, alice, async () =>
      db.query<{ owner_id: string }>("select owner_id from public.body_measurements"),
    );
    expect(visible.rows.map((row) => row.owner_id)).toStrictEqual([alice]);
  });

  it("他利用者の測定記録は id を指定しても見えない", async () => {
    const other = await asAuthenticated(db, bob, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.body_measurements where id = $1",
        [aliceMeasurement],
      ),
    );
    expect(other.rows[0]?.count).toBe("0");
  });

  it("他利用者の測定記録は更新も削除もできない（0件になる）", async () => {
    const updated = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>(
        "update public.body_measurements set value = 1 where id = $1 returning id",
        [aliceMeasurement],
      ),
    );
    expect(updated.rows).toStrictEqual([]);

    const deleted = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>("delete from public.body_measurements where id = $1 returning id", [
        aliceMeasurement,
      ]),
    );
    expect(deleted.rows).toStrictEqual([]);

    const untouched = await db.query<{ value: string }>(
      "select value::text as value from public.body_measurements where id = $1",
      [aliceMeasurement],
    );
    expect(Number(untouched.rows[0]?.value)).toBe(62);
  });

  it("他利用者を owner_id に指定した INSERT は弾かれる", async () => {
    // 測定種別は他テーブルを参照しないため、RLS の with check がそのまま反応する。
    const typeInsert = await expectRejection(() =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.body_measurement_types
             (owner_id, measurement_key, display_name, unit_constraint, default_unit)
           values ($1, 'stolen_metric', '横取り', 'custom', 'custom')`,
          [alice],
        ),
      ),
    );
    expect(typeInsert).toMatch(/row-level security/i);

    // 測定記録は、単位制約トリガーの参照自体が RLS 適用下にあるため、
    // 他利用者の種別を「見つからない」として先に弾く（多層防御）。
    const measurementInsert = await expectRejection(() =>
      asAuthenticated(db, bob, async () =>
        db.query(
          `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
           values ($1, $2, now(), 62, 'kg')`,
          [alice, aliceWeightType],
        ),
      ),
    );
    expect(measurementInsert).toMatch(/measurement type not found for owner|row-level security/i);
  });

  it("自分の測定種別・目標だけが見える", async () => {
    const types = await asAuthenticated(db, alice, async () =>
      db.query<{ owner_id: string }>("select distinct owner_id from public.body_measurement_types"),
    );
    expect(types.rows.map((row) => row.owner_id)).toStrictEqual([alice]);

    const goals = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>("select id from public.body_measurement_goals"),
    );
    expect(goals.rows).toStrictEqual([]);
  });

  it("measurement_key / unit_constraint / is_default は列レベル権限で更新できない", async () => {
    for (const column of ["measurement_key", "unit_constraint", "is_default"]) {
      const value = column === "is_default" ? "true" : "'x'";
      const message = await expectRejection(() =>
        asAuthenticated(db, alice, async () =>
          db.query(
            `update public.body_measurement_types set ${column} = ${value} where owner_id = $1`,
            [alice],
          ),
        ),
      );
      expect(message, column).toMatch(/permission denied/i);
    }
  });

  it("測定種別の DELETE は authenticated に許可されていない（archived_at で無効化する）", async () => {
    const message = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query("delete from public.body_measurement_types where owner_id = $1", [alice]),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it("active でない利用者は自分の行も操作できない (実装仕様書 5.1節 / 6.5節)", async () => {
    await db.query("update public.users set status = 'suspended' where id = $1", [alice]);

    const readable = await asAuthenticated(db, alice, async () =>
      db.query<{ count: string }>("select count(*)::text as count from public.body_measurements"),
    );
    expect(readable.rows[0]?.count).toBe("0");

    const insertedType = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query(
          `insert into public.body_measurement_types
             (owner_id, measurement_key, display_name, unit_constraint, default_unit)
           values ($1, 'while_suspended', '停止中', 'custom', 'custom')`,
          [alice],
        ),
      ),
    );
    expect(insertedType).toMatch(/row-level security/i);

    const insertedMeasurement = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query(
          `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
           values ($1, $2, now(), 63, 'kg')`,
          [alice, aliceWeightType],
        ),
      ),
    );
    expect(insertedMeasurement).toMatch(/measurement type not found for owner|row-level security/i);

    const goalsVisible = await asAuthenticated(db, alice, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.body_measurement_types",
      ),
    );
    expect(goalsVisible.rows[0]?.count).toBe("0");

    await db.query("update public.users set status = 'active' where id = $1", [alice]);
  });

  it("アカウント削除で測定データが CASCADE 削除される (実装仕様書 6.2節)", async () => {
    const doomed = await signUp(db, "rls-doomed@example.test");
    await asAuthenticated(db, doomed, async () =>
      db.query("select public.seed_default_body_measurement_types()"),
    );
    const doomedType = await weightTypeOf(doomed);
    await asAuthenticated(db, doomed, async () =>
      db.query(
        `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
         values ($1, $2, now(), 55, 'kg')`,
        [doomed, doomedType],
      ),
    );

    await db.query("delete from auth.users where id = $1", [doomed]);

    const remaining = await db.query<{ types: string; measurements: string; goals: string }>(
      `select
         (select count(*)::text from public.body_measurement_types where owner_id = $1) as types,
         (select count(*)::text from public.body_measurements where owner_id = $1) as measurements,
         (select count(*)::text from public.body_measurement_goals where owner_id = $1) as goals`,
      [doomed],
    );

    expect(remaining.rows[0]).toStrictEqual({ types: "0", measurements: "0", goals: "0" });
  });
});

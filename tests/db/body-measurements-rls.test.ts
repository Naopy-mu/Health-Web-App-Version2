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
  let aliceGoal: string;

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

    const aliceGoalRow = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
         values ($1, $2, 58, 'kg') returning id`,
        [alice, aliceWeightType],
      ),
    );
    aliceGoal = aliceGoalRow.rows[0]?.id ?? "";
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

    // bob も目標を持っているが、alice からは自分の1件だけが見える。
    const goals = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string; owner_id: string }>(
        "select id, owner_id from public.body_measurement_goals",
      ),
    );
    expect(goals.rows).toStrictEqual([{ id: aliceGoal, owner_id: alice }]);
  });

  it("他利用者の測定目標は更新も削除もできない（0件になる）", async () => {
    const updated = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>(
        "update public.body_measurement_goals set target_value = 1 where id = $1 returning id",
        [aliceGoal],
      ),
    );
    expect(updated.rows).toStrictEqual([]);

    const deleted = await asAuthenticated(db, bob, async () =>
      db.query<{ id: string }>(
        "delete from public.body_measurement_goals where id = $1 returning id",
        [aliceGoal],
      ),
    );
    expect(deleted.rows).toStrictEqual([]);

    const untouched = await db.query<{ target_value: string }>(
      "select target_value::text as target_value from public.body_measurement_goals where id = $1",
      [aliceGoal],
    );
    expect(Number(untouched.rows[0]?.target_value)).toBe(58);
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

  it("authenticated は is_default=true の行を直接作れない (実装仕様書 5.3節)", async () => {
    // 列レベル権限から is_default が外れているため、値を渡した時点で拒否される。
    const message = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query(
          `insert into public.body_measurement_types
             (owner_id, measurement_key, display_name, unit_constraint, default_unit, is_default)
           values ($1, 'fake_default', 'にせ既定', 'custom', 'custom', true)`,
          [alice],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);

    const stored = await db.query<{ count: string }>(
      `select count(*)::text as count from public.body_measurement_types
       where owner_id = $1 and measurement_key = 'fake_default'`,
      [alice],
    );
    expect(stored.rows[0]?.count).toBe("0");
  });

  it("authenticated は is_default=true の行を直接 UPDATE できない (実装仕様書 5.3節)", async () => {
    // 列レベル権限（migration 20260827000600）は display_name / default_unit /
    // sort_order / archived_at / client_mutation_id の UPDATE を authenticated へ
    // 与えている。カスタム種別の編集には要る権限だが、既定種別の行へ向けると
    // 既定カタログの改ざん（ラベル・単位の偽装）が成立してしまう。
    // 行の判定は列レベルでは書けないため、トリガーが 42501 で拒否する。
    const before = await db.query<{
      display_name: string;
      default_unit: string;
      sort_order: number;
      row_version: string;
    }>(
      `select display_name, default_unit, sort_order, row_version::text as row_version
       from public.body_measurement_types
       where owner_id = $1 and measurement_key = 'weight'`,
      [alice],
    );

    const spoofs = [
      "display_name = 'spoofed label'",
      "default_unit = 'lb'",
      "sort_order = 999",
      "client_mutation_id = '00000000-0000-4000-8000-0000000000ff'",
      "display_name = 'spoofed label', default_unit = 'lb', sort_order = 999",
    ];

    for (const assignment of spoofs) {
      const message = await expectRejection(() =>
        asAuthenticated(db, alice, async () =>
          db.query(
            `update public.body_measurement_types set ${assignment}
             where owner_id = $1 and measurement_key = 'weight'`,
            [alice],
          ),
        ),
      );
      expect(message, assignment).toContain(
        "default measurement types can only be modified by public.seed_default_body_measurement_types()",
      );
    }

    // 1件も通っていない（版番号も進んでいない）。
    const after = await db.query<{
      display_name: string;
      default_unit: string;
      sort_order: number;
      row_version: string;
    }>(
      `select display_name, default_unit, sort_order, row_version::text as row_version
       from public.body_measurement_types
       where owner_id = $1 and measurement_key = 'weight'`,
      [alice],
    );
    expect(after.rows[0]).toStrictEqual(before.rows[0]);
    expect(after.rows[0]?.display_name).toBe("体重");
  });

  it("同じ UPDATE でもカスタム種別なら通る（拒否は既定種別の行だけ）", async () => {
    const custom = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.body_measurement_types
           (owner_id, measurement_key, display_name, unit_constraint, default_unit)
         values ($1, 'editable_metric', '編集できる', 'custom', 'custom') returning id`,
        [alice],
      ),
    );

    const updated = await asAuthenticated(db, alice, async () =>
      db.query<{ display_name: string; sort_order: number }>(
        `update public.body_measurement_types set display_name = '改名', sort_order = 20
         where id = $1 and owner_id = $2 returning display_name, sort_order`,
        [custom.rows[0]?.id, alice],
      ),
    );
    expect(updated.rows[0]).toStrictEqual({ display_name: "改名", sort_order: 20 });
  });

  it("seed RPC は拒否の対象外で、既定種別をカタログへ正規化できる", async () => {
    // 改ざんは拒否されるが、正規の経路（GUC を立てる SECURITY DEFINER の RPC）は通る。
    // 既定種別の唯一の書き手であることの確認。
    const seeded = await asAuthenticated(db, alice, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.seed_default_body_measurement_types()",
      ),
    );
    expect(seeded.rows[0]?.count).toBe("10");
  });

  it("既定カタログのキーはカスタム種別が名乗れない（既定種別の偽装を防ぐ）", async () => {
    // is_default を送らなくても、キーそのものが予約されている。
    // これが無いと「先に custom の weight を作る → seed が読み飛ばす」で偽装できる。
    const other = await signUp(db, "rls-impostor@example.test");

    const message = await expectRejection(() =>
      asAuthenticated(db, other, async () =>
        db.query(
          `insert into public.body_measurement_types
             (owner_id, measurement_key, display_name, unit_constraint, default_unit)
           values ($1, 'weight', '体重（自作）', 'custom', 'custom')`,
          [other],
        ),
      ),
    );
    expect(message).toContain("reserved for the default measurement catalog");

    // 正規の経路（seed RPC）なら既定種別として入る。
    await asAuthenticated(db, other, async () =>
      db.query("select public.seed_default_body_measurement_types()"),
    );
    const seeded = await db.query<{ is_default: boolean; unit_constraint: string }>(
      `select is_default, unit_constraint from public.body_measurement_types
       where owner_id = $1 and measurement_key = 'weight'`,
      [other],
    );
    expect(seeded.rows[0]).toStrictEqual({ is_default: true, unit_constraint: "mass" });
  });

  it("アーカイブ済み種別へは新規登録できないが、既存行の訂正はできる (実装仕様書 5.3節)", async () => {
    const custom = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.body_measurement_types
           (owner_id, measurement_key, display_name, unit_constraint, default_unit)
         values ($1, 'grip_strength', '握力', 'custom', 'custom') returning id`,
        [alice],
      ),
    );
    const customType = custom.rows[0]?.id ?? "";

    const before = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
         values ($1, $2, timestamptz '2026-07-02T00:00:00Z', 40, 'custom') returning id`,
        [alice, customType],
      ),
    );
    const beforeArchive = before.rows[0]?.id ?? "";

    const archived = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        "update public.body_measurement_types set archived_at = now() where id = $1 returning id",
        [customType],
      ),
    );
    expect(archived.rows).toHaveLength(1);

    const newMeasurement = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query(
          `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
           values ($1, $2, timestamptz '2026-07-03T00:00:00Z', 41, 'custom')`,
          [alice, customType],
        ),
      ),
    );
    expect(newMeasurement).toContain("measurement type is archived");

    const newGoal = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query(
          `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
           values ($1, $2, 45, 'custom')`,
          [alice, customType],
        ),
      ),
    );
    expect(newGoal).toContain("measurement type is archived");

    // 既存の記録は直せる（アーカイブは過去データを凍結しない）。
    const corrected = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        "update public.body_measurements set value = 39 where id = $1 returning id",
        [beforeArchive],
      ),
    );
    expect(corrected.rows).toHaveLength(1);

    // アーカイブ解除で再び登録できる。
    await asAuthenticated(db, alice, async () =>
      db.query("update public.body_measurement_types set archived_at = null where id = $1", [
        customType,
      ]),
    );
    const reopened = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
         values ($1, $2, timestamptz '2026-07-04T00:00:00Z', 42, 'custom') returning id`,
        [alice, customType],
      ),
    );
    expect(reopened.rows).toHaveLength(1);
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

    // 目標も同じく見えない（種別テーブルではなく目標テーブルを確かめる）。
    const goalsVisible = await asAuthenticated(db, alice, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.body_measurement_goals",
      ),
    );
    expect(goalsVisible.rows[0]?.count).toBe("0");

    // 非active では自分の目標の作成・更新・削除も通らない。
    const insertedGoal = await expectRejection(() =>
      asAuthenticated(db, alice, async () =>
        db.query(
          `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
           values ($1, $2, 57, 'kg')`,
          [alice, aliceWeightType],
        ),
      ),
    );
    expect(insertedGoal).toMatch(/measurement type not found for owner|row-level security/i);

    const updatedGoal = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        "update public.body_measurement_goals set target_value = 2 where id = $1 returning id",
        [aliceGoal],
      ),
    );
    expect(updatedGoal.rows).toStrictEqual([]);

    const deletedGoal = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        "delete from public.body_measurement_goals where id = $1 returning id",
        [aliceGoal],
      ),
    );
    expect(deletedGoal.rows).toStrictEqual([]);

    await db.query("update public.users set status = 'active' where id = $1", [alice]);

    // active へ戻せば自分の目標はそのまま残っている。
    const restored = await asAuthenticated(db, alice, async () =>
      db.query<{ target_value: string }>(
        "select target_value::text as target_value from public.body_measurement_goals where id = $1",
        [aliceGoal],
      ),
    );
    expect(Number(restored.rows[0]?.target_value)).toBe(58);
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

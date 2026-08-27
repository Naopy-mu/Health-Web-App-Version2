// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_MEASUREMENT_TYPES } from "../../src/features/body-measurements/defaults";
import {
  CENTIMETERS_PER_INCH,
  KILOGRAMS_PER_POUND,
} from "../../src/features/body-measurements/units";

import { asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

/**
 * 身体測定のスキーマ契約（実装仕様書 5.3節 / 6.2節 / 6.4節）。
 * PGlite へ migration を新規適用して検証する（実装仕様書 12章のDB検証）。
 */
describe("身体測定のテーブル定義 (実装仕様書 5.3節 / 6.2節)", () => {
  let db: PGlite;
  let owner: string;
  let stranger: string;

  const seedDefaults = async (userId: string) =>
    asAuthenticated(db, userId, async () =>
      db.query<{ id: string; measurement_key: string; unit_constraint: string }>(
        "select id, measurement_key, unit_constraint from public.seed_default_body_measurement_types()",
      ),
    );

  const typeIdOf = async (userId: string, key: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.body_measurement_types where owner_id = $1 and measurement_key = $2",
      [userId, key],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`measurement type not found: ${key}`);
    }
    return id;
  };

  beforeAll(async () => {
    db = await createMigratedDatabase();
    owner = await signUp(db, "measure-owner@example.test");
    stranger = await signUp(db, "measure-stranger@example.test");
    await seedDefaults(owner);
    await seedDefaults(stranger);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("3テーブルが作られ、共通パターンの列を持つ (実装仕様書 6.4節)", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
         and table_name in ('body_measurement_types', 'body_measurements', 'body_measurement_goals')
         and column_name in ('owner_id', 'client_mutation_id', 'row_version')
       order by table_name, column_name`,
    );

    expect(rows).toStrictEqual([
      {
        table_name: "body_measurement_goals",
        column_name: "client_mutation_id",
        data_type: "uuid",
      },
      { table_name: "body_measurement_goals", column_name: "owner_id", data_type: "uuid" },
      { table_name: "body_measurement_goals", column_name: "row_version", data_type: "bigint" },
      {
        table_name: "body_measurement_types",
        column_name: "client_mutation_id",
        data_type: "uuid",
      },
      { table_name: "body_measurement_types", column_name: "owner_id", data_type: "uuid" },
      { table_name: "body_measurement_types", column_name: "row_version", data_type: "bigint" },
      { table_name: "body_measurements", column_name: "client_mutation_id", data_type: "uuid" },
      { table_name: "body_measurements", column_name: "owner_id", data_type: "uuid" },
      { table_name: "body_measurements", column_name: "row_version", data_type: "bigint" },
    ]);
  });

  it("3テーブルとも (owner_id, client_mutation_id) の NULL 除外一意インデックスを持つ", async () => {
    const { rows } = await db.query<{ tablename: string; indexdef: string }>(
      `select tablename, indexdef from pg_indexes
       where schemaname = 'public'
         and indexname like 'body_measurement%_owner_client_mutation_key'
       order by tablename`,
    );

    expect(rows.map((row) => row.tablename)).toStrictEqual([
      "body_measurement_goals",
      "body_measurement_types",
      "body_measurements",
    ]);
    for (const row of rows) {
      expect(row.indexdef).toContain("(owner_id, client_mutation_id)");
      expect(row.indexdef).toContain("WHERE (client_mutation_id IS NOT NULL)");
    }
  });

  it("記録・目標が (type_id, owner_id) -> types (id, owner_id) の複合外部キーを持つ (実装仕様書 6.2節)", async () => {
    const { rows } = await db.query<{ conname: string; definition: string }>(
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conname in ('body_measurements_type_fkey', 'body_measurement_goals_type_fkey')
       order by conname`,
    );

    expect(rows).toStrictEqual([
      {
        conname: "body_measurement_goals_type_fkey",
        definition:
          "FOREIGN KEY (type_id, owner_id) REFERENCES body_measurement_types(id, owner_id) ON DELETE CASCADE",
      },
      {
        conname: "body_measurements_type_fkey",
        definition:
          "FOREIGN KEY (type_id, owner_id) REFERENCES body_measurement_types(id, owner_id) ON DELETE CASCADE",
      },
    ]);
  });

  it("時系列検索の複合インデックス (owner_id, measured_at) を持つ (実装仕様書 6.2節)", async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'body_measurements'
       order by indexname`,
    );

    expect(rows.map((row) => row.indexname)).toContain("body_measurements_owner_measured_at_idx");
    expect(rows.map((row) => row.indexname)).toContain(
      "body_measurements_owner_type_measured_at_idx",
    );
  });

  it("他利用者の測定種別へ記録を接続できない (実装仕様書 6.2節)", async () => {
    const strangerWeight = await typeIdOf(stranger, "weight");

    const message = await expectRejection(() =>
      db.query(
        `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
         values ($1, $2, now(), 60, 'kg')`,
        [owner, strangerWeight],
      ),
    );

    // BEFORE トリガー（単位制約の確認）が先に (type_id, owner_id) の不在を検出する。
    // 仮にトリガーが無くても、複合外部キー body_measurements_type_fkey が同じ行を拒否する
    // （制約定義は上のテストで確認済み）。
    expect(message).toMatch(/measurement type not found for owner|body_measurements_type_fkey/);

    // 自分の種別なら同じ文で通る（拒否理由が所有者の不一致であることの裏取り）。
    const ownWeight = await typeIdOf(owner, "weight");
    const accepted = await db.query<{ id: string }>(
      `insert into public.body_measurements (owner_id, type_id, measured_at, value, unit)
       values ($1, $2, timestamptz '2026-09-09T00:00:00Z', 60, 'kg') returning id`,
      [owner, ownWeight],
    );
    expect(accepted.rows).toHaveLength(1);
  });
});

describe("既定の測定種別 (実装仕様書 5.3節)", () => {
  let db: PGlite;
  let owner: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    owner = await signUp(db, "defaults@example.test");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("カタログが既定10種別（体重〜肩幅）を持つ", async () => {
    const { rows } = await db.query<{
      measurement_key: string;
      display_name: string;
      unit_constraint: string;
      default_unit: string;
      sort_order: number;
    }>("select * from public.default_body_measurement_types() order by sort_order");

    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.display_name)).toStrictEqual([
      "体重",
      "体脂肪率",
      "BMI",
      "ウエスト",
      "へそ周り",
      "骨盤周り",
      "ヒップ",
      "太もも",
      "ふくらはぎ",
      "肩幅",
    ]);
  });

  it("TypeScript 側のカタログ（features/body-measurements/defaults.ts）と一致する", async () => {
    const { rows } = await db.query<{
      measurement_key: string;
      display_name: string;
      unit_constraint: string;
      default_unit: string;
      sort_order: number;
    }>("select * from public.default_body_measurement_types() order by sort_order");

    expect(
      rows.map((row) => ({
        measurementKey: row.measurement_key,
        displayName: row.display_name,
        unitConstraint: row.unit_constraint,
        defaultUnit: row.default_unit,
        sortOrder: Number(row.sort_order),
      })),
    ).toStrictEqual([...DEFAULT_MEASUREMENT_TYPES]);
  });

  it("seed RPC が既定10種別を投入し、再実行しても増えない（冪等）", async () => {
    const first = await asAuthenticated(db, owner, async () =>
      db.query<{ id: string }>("select id from public.seed_default_body_measurement_types()"),
    );
    expect(first.rows).toHaveLength(10);

    const second = await asAuthenticated(db, owner, async () =>
      db.query<{ id: string }>("select id from public.seed_default_body_measurement_types()"),
    );
    expect(second.rows).toHaveLength(10);
    expect(second.rows.map((row) => row.id).sort()).toStrictEqual(
      first.rows.map((row) => row.id).sort(),
    );

    const stored = await db.query<{ count: string }>(
      "select count(*)::text as count from public.body_measurement_types where owner_id = $1",
      [owner],
    );
    expect(stored.rows[0]?.count).toBe("10");
  });

  it("seed RPC は未認証では失敗する", async () => {
    const message = await expectRejection(() =>
      db.query("select public.seed_default_body_measurement_types()"),
    );
    expect(message).toContain("authentication required");
  });

  it("既定カタログに無いキーで is_default を名乗れない", async () => {
    const message = await expectRejection(() =>
      db.query(
        `insert into public.body_measurement_types
           (owner_id, measurement_key, display_name, unit_constraint, default_unit, is_default)
         values ($1, 'my_custom_metric', 'カスタム', 'custom', 'custom', true)`,
        [owner],
      ),
    );
    expect(message).toContain("is_default is reserved");
  });

  it("既定種別はアーカイブできない", async () => {
    const message = await expectRejection(() =>
      db.query(
        `update public.body_measurement_types set archived_at = now()
         where owner_id = $1 and measurement_key = 'weight'`,
        [owner],
      ),
    );
    expect(message).toContain("cannot be archived");
  });

  it("既定種別の単位制約・項目キーは変更できない", async () => {
    const constraintChange = await expectRejection(() =>
      db.query(
        `update public.body_measurement_types set unit_constraint = 'length'
         where owner_id = $1 and measurement_key = 'weight'`,
        [owner],
      ),
    );
    expect(constraintChange).toContain('column "unit_constraint" is immutable');

    const keyChange = await expectRejection(() =>
      db.query(
        `update public.body_measurement_types set measurement_key = 'weight_v2'
         where owner_id = $1 and measurement_key = 'weight'`,
        [owner],
      ),
    );
    expect(keyChange).toContain('column "measurement_key" is immutable');
  });

  it("カスタム項目キーの形（^[a-z][a-z0-9_]{1,49}$）を強制する", async () => {
    for (const key of ["A", "1abc", "ab-cd", "x", "with space"]) {
      const message = await expectRejection(() =>
        db.query(
          `insert into public.body_measurement_types
             (owner_id, measurement_key, display_name, unit_constraint, default_unit)
           values ($1, $2, 'カスタム', 'custom', 'custom')`,
          [owner, key],
        ),
      );
      expect(message, key).toMatch(/body_measurement_types_key_format/);
    }

    const accepted = await db.query<{ id: string }>(
      `insert into public.body_measurement_types
         (owner_id, measurement_key, display_name, unit_constraint, default_unit)
       values ($1, 'grip_strength', '握力', 'custom', 'custom') returning id`,
      [owner],
    );
    expect(accepted.rows).toHaveLength(1);
  });

  it("既定単位が単位制約に合わない種別を拒否する", async () => {
    const message = await expectRejection(() =>
      db.query(
        `insert into public.body_measurement_types
           (owner_id, measurement_key, display_name, unit_constraint, default_unit)
         values ($1, 'bad_unit', '不整合', 'mass', 'cm')`,
        [owner],
      ),
    );
    expect(message).toMatch(/body_measurement_types_default_unit_matches/);
  });

  it("同一所有者で項目キーが重複しない（別所有者では衝突しない）", async () => {
    const other = await signUp(db, "defaults-other@example.test");

    const duplicate = await expectRejection(() =>
      db.query(
        `insert into public.body_measurement_types
           (owner_id, measurement_key, display_name, unit_constraint, default_unit)
         values ($1, 'grip_strength', '握力（重複）', 'custom', 'custom')`,
        [owner],
      ),
    );
    expect(duplicate).toMatch(/body_measurement_types_owner_key_key/);

    const otherOwner = await db.query<{ id: string }>(
      `insert into public.body_measurement_types
         (owner_id, measurement_key, display_name, unit_constraint, default_unit)
       values ($1, 'grip_strength', '握力', 'custom', 'custom') returning id`,
      [other],
    );
    expect(otherOwner.rows).toHaveLength(1);
  });
});

describe("測定記録の制約 (実装仕様書 5.3節)", () => {
  let db: PGlite;
  let owner: string;
  let weightTypeId: string;
  let waistTypeId: string;

  const insertMeasurement = async (columns: string, values: string, params: readonly unknown[]) =>
    db.query<{ id: string }>(
      `insert into public.body_measurements (${columns}) values (${values}) returning id`,
      [...params],
    );

  beforeAll(async () => {
    db = await createMigratedDatabase();
    owner = await signUp(db, "records@example.test");
    await asAuthenticated(db, owner, async () =>
      db.query("select public.seed_default_body_measurement_types()"),
    );

    const types = await db.query<{ id: string; measurement_key: string }>(
      "select id, measurement_key from public.body_measurement_types where owner_id = $1",
      [owner],
    );
    weightTypeId = types.rows.find((row) => row.measurement_key === "weight")?.id ?? "";
    waistTypeId = types.rows.find((row) => row.measurement_key === "waist")?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("値は 0 超 1000 以下に制限される", async () => {
    for (const value of [0, -1, 1000.001, 1500]) {
      const message = await expectRejection(() =>
        insertMeasurement(
          "owner_id, type_id, measured_at, value, unit",
          "$1, $2, now(), $3, 'kg'",
          [owner, weightTypeId, value],
        ),
      );
      expect(message, String(value)).toMatch(/body_measurements_value_range/);
    }

    const accepted = await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit",
      "$1, $2, timestamptz '2026-01-01T00:00:00Z', 1000, 'kg'",
      [owner, weightTypeId],
    );
    expect(accepted.rows).toHaveLength(1);
  });

  it("同一の所有者・種別・日時の重複登録を一意制約で防ぐ", async () => {
    const at = "2026-02-01T07:00:00Z";

    await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit",
      `$1, $2, timestamptz '${at}', 62, 'kg'`,
      [owner, weightTypeId],
    );

    const duplicate = await expectRejection(() =>
      insertMeasurement(
        "owner_id, type_id, measured_at, value, unit",
        `$1, $2, timestamptz '${at}', 63, 'kg'`,
        [owner, weightTypeId],
      ),
    );
    expect(duplicate).toMatch(/body_measurements_owner_type_measured_at_key/);

    // 種別が違えば同じ日時でも登録できる。
    const otherType = await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit",
      `$1, $2, timestamptz '${at}', 70, 'cm'`,
      [owner, waistTypeId],
    );
    expect(otherType.rows).toHaveLength(1);
  });

  it("単位が測定種別の単位制約に合わないと拒否される", async () => {
    const message = await expectRejection(() =>
      insertMeasurement(
        "owner_id, type_id, measured_at, value, unit",
        "$1, $2, timestamptz '2026-03-01T00:00:00Z', 62, 'cm'",
        [owner, weightTypeId],
      ),
    );
    expect(message).toContain('unit "cm" is not allowed for unit_constraint "mass"');

    const pounds = await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit",
      "$1, $2, timestamptz '2026-03-02T00:00:00Z', 140, 'lb'",
      [owner, weightTypeId],
    );
    expect(pounds.rows).toHaveLength(1);
  });

  it("正規化値の生成列が kg / cm へ換算する (実装仕様書 6.3節)", async () => {
    const { rows } = await db.query<{
      unit: string;
      value: string;
      normalized_value: string;
      normalized_unit: string | null;
    }>(
      `select unit, value::text as value, normalized_value::text as normalized_value, normalized_unit
       from public.body_measurements
       where owner_id = $1 and measured_at = timestamptz '2026-03-02T00:00:00Z'`,
      [owner],
    );

    expect(rows[0]?.normalized_unit).toBe("kg");
    expect(Number(rows[0]?.normalized_value)).toBeCloseTo(140 * KILOGRAMS_PER_POUND, 6);

    const inch = await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit",
      "$1, $2, timestamptz '2026-03-03T00:00:00Z', 30, 'inch'",
      [owner, waistTypeId],
    );
    expect(inch.rows).toHaveLength(1);

    const converted = await db.query<{ normalized_value: string; normalized_unit: string }>(
      `select normalized_value::text as normalized_value, normalized_unit
       from public.body_measurements where id = $1`,
      [inch.rows[0]?.id],
    );
    expect(converted.rows[0]?.normalized_unit).toBe("cm");
    expect(Number(converted.rows[0]?.normalized_value)).toBeCloseTo(30 * CENTIMETERS_PER_INCH, 6);
  });

  it("メモ500字・測定条件200字・測定部位100字の上限を課す", async () => {
    const cases: readonly [string, number, RegExp][] = [
      ["note", 501, /body_measurements_note_length/],
      ["measurement_condition", 201, /body_measurements_condition_length/],
      ["body_site", 101, /body_measurements_body_site_length/],
    ];

    for (const [column, length, pattern] of cases) {
      const message = await expectRejection(() =>
        insertMeasurement(
          `owner_id, type_id, measured_at, value, unit, ${column}`,
          "$1, $2, now(), 62, 'kg', $3",
          [owner, weightTypeId, "あ".repeat(length)],
        ),
      );
      expect(message, column).toMatch(pattern);
    }
  });

  it("写真参照は HTTPS URL か自分の storage:// パスだけを許す (実装仕様書 5.3節 / 6.6節)", async () => {
    const objectUuid = "6b1f1c1a-2d3e-4f50-8a9b-0c1d2e3f4a5b";

    const allowed = [
      "https://example.test/photos/a.jpg",
      `storage://health-images/${owner}/${objectUuid}.jpg`,
    ];
    let at = 0;
    for (const reference of allowed) {
      at += 1;
      const inserted = await insertMeasurement(
        "owner_id, type_id, measured_at, value, unit, photo_reference",
        `$1, $2, timestamptz '2026-04-0${at}T00:00:00Z', 62, 'kg', $3`,
        [owner, weightTypeId, reference],
      );
      expect(inserted.rows, reference).toHaveLength(1);
    }

    const rejected = [
      "http://example.test/photos/a.jpg",
      "javascript:alert(1)",
      "storage://food-images-private/" + owner + "/" + objectUuid + ".jpg",
      // 他利用者のUIDを先頭に置いたパス。
      `storage://health-images/00000000-0000-0000-0000-0000000000ff/${objectUuid}.jpg`,
    ];
    for (const reference of rejected) {
      const message = await expectRejection(() =>
        insertMeasurement(
          "owner_id, type_id, measured_at, value, unit, photo_reference",
          "$1, $2, now(), 62, 'kg', $3",
          [owner, weightTypeId, reference],
        ),
      );
      expect(message, reference).toMatch(/body_measurements_photo_reference_shape/);
    }
  });

  it("楽観ロック: row_version 不一致の UPDATE は 0 件（HTTP 409 相当。実装仕様書 6.4節）", async () => {
    const created = await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit",
      "$1, $2, timestamptz '2026-05-01T00:00:00Z', 62, 'kg'",
      [owner, weightTypeId],
    );
    const id = created.rows[0]?.id;

    const stale = await asAuthenticated(db, owner, async () =>
      db.query<{ id: string }>(
        `update public.body_measurements set value = 61
         where id = $1 and owner_id = $2 and row_version = 99 returning id`,
        [id, owner],
      ),
    );
    expect(stale.rows).toHaveLength(0);

    const fresh = await asAuthenticated(db, owner, async () =>
      db.query<{ row_version: string }>(
        `update public.body_measurements set value = 61
         where id = $1 and owner_id = $2 and row_version = 1
         returning row_version::text as row_version`,
        [id, owner],
      ),
    );
    expect(fresh.rows[0]?.row_version).toBe("2");
  });

  it("冪等キー: 同一所有者の client_mutation_id 重複を拒否する (実装仕様書 6.4節)", async () => {
    const mutationId = "8a0f6b2e-1c3d-4e5f-9a0b-1c2d3e4f5a6b";

    await insertMeasurement(
      "owner_id, type_id, measured_at, value, unit, client_mutation_id",
      "$1, $2, timestamptz '2026-06-01T00:00:00Z', 62, 'kg', $3",
      [owner, weightTypeId, mutationId],
    );

    const replay = await expectRejection(() =>
      insertMeasurement(
        "owner_id, type_id, measured_at, value, unit, client_mutation_id",
        "$1, $2, timestamptz '2026-06-02T00:00:00Z', 62, 'kg', $3",
        [owner, weightTypeId, mutationId],
      ),
    );
    expect(replay).toMatch(/body_measurements_owner_client_mutation_key/);
  });
});

describe("測定目標の制約 (実装仕様書 5.3節)", () => {
  let db: PGlite;
  let owner: string;
  let weightTypeId: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    owner = await signUp(db, "goals@example.test");
    await asAuthenticated(db, owner, async () =>
      db.query("select public.seed_default_body_measurement_types()"),
    );
    const { rows } = await db.query<{ id: string }>(
      "select id from public.body_measurement_types where owner_id = $1 and measurement_key = 'weight'",
      [owner],
    );
    weightTypeId = rows[0]?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("未達成の目標は測定種別ごとに1件だけ", async () => {
    await db.query(
      `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
       values ($1, $2, 60, 'kg')`,
      [owner, weightTypeId],
    );

    const duplicate = await expectRejection(() =>
      db.query(
        `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
         values ($1, $2, 59, 'kg')`,
        [owner, weightTypeId],
      ),
    );
    expect(duplicate).toMatch(/body_measurement_goals_owner_type_active_key/);

    // 達成済みにすれば新しい目標を作れる。
    await db.query(
      "update public.body_measurement_goals set achieved_at = now() where owner_id = $1",
      [owner],
    );
    const next = await db.query<{ id: string }>(
      `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit)
       values ($1, $2, 58, 'kg') returning id`,
      [owner, weightTypeId],
    );
    expect(next.rows).toHaveLength(1);
  });

  it("目標の単位も測定種別の単位制約に従う", async () => {
    const message = await expectRejection(() =>
      db.query(
        `insert into public.body_measurement_goals (owner_id, type_id, target_value, unit, achieved_at)
         values ($1, $2, 60, 'percent', now())`,
        [owner, weightTypeId],
      ),
    );
    expect(message).toContain('unit "percent" is not allowed for unit_constraint "mass"');
  });
});

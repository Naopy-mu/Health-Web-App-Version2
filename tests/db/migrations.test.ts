// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATION_FILE_PATTERN, createMigratedDatabase, readMigrations } from "./pglite";

describe("supabase/migrations (実装仕様書 6章 / 12章)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("ファイル名が YYYYMMDDHHMMSS の連番規則に従う", () => {
    const names = readMigrations().map((migration) => migration.name);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(MIGRATION_FILE_PATTERN);
    }

    const timestamps = names.map((name) => name.slice(0, 14));
    expect(timestamps).toStrictEqual([...timestamps].sort());
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps[0]).toBe("20260827000100");
  });

  it("まっさらなデータベースへ新規適用できる", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );

    expect(rows.map((row) => row.table_name)).toStrictEqual([
      // Phase 4-1a: 睡眠・水分・体調（実装仕様書 5.5節）
      "beverage_types",
      // Phase 3a: 身体測定（実装仕様書 5.3節）
      "body_measurement_goals",
      "body_measurement_mutation_log",
      "body_measurement_types",
      "body_measurements",
      "condition_entries",
      "condition_entry_symptoms",
      "hydration_entries",
      "hydration_goals",
      "sleep_entries",
      "sleep_goals",
      "symptom_types",
      // Phase 1: ID・プロフィール（実装仕様書 6.1節）
      "user_profiles",
      "users",
      "wellness_mutation_log",
    ]);
  });

  it("未着手のフェーズの機能テーブルはまだ作らない", async () => {
    // Phase 3a は身体測定（実装仕様書 5.3節）、Phase 4-1a は睡眠・水分・体調
    // （5.5節）まで。運動・食事・習慣などは後続フェーズ。
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public'
         and table_name in ('workout_sessions', 'meal_recipes', 'habits', 'supplement_products')`,
    );

    expect(rows[0]?.count).toBe("0");
  });

  it("users.id が auth.users を参照し owner_id = id が固定されている", async () => {
    const foreignKey = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.users'::regclass and contype = 'f'`,
    );
    expect(foreignKey.rows.map((row) => row.definition)).toContain(
      "FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE",
    );

    const check = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.users'::regclass and conname = 'users_owner_id_matches_id'`,
    );
    expect(check.rows[0]?.definition).toBe("CHECK ((owner_id = id))");
  });

  it("user_profiles が (id, owner_id) -> users (id, owner_id) の複合外部キーを持つ", async () => {
    const { rows } = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.user_profiles'::regclass and conname = 'user_profiles_owner_fkey'`,
    );

    expect(rows[0]?.definition).toBe(
      "FOREIGN KEY (id, owner_id) REFERENCES users(id, owner_id) ON DELETE CASCADE",
    );
  });

  it("id の既定値が gen_random_uuid() である", async () => {
    const { rows } = await db.query<{ column_default: string | null }>(
      `select column_default from information_schema.columns
       where table_schema = 'auth' and table_name = 'users' and column_name = 'id'`,
    );

    // シム側の auth.users も含め、UUID主キーの既定値は gen_random_uuid() に統一する。
    expect(rows[0]?.column_default).toBe("gen_random_uuid()");
  });

  it("auth.users の AFTER INSERT トリガー on_auth_user_created が SECURITY DEFINER である", async () => {
    const trigger = await db.query<{ tgname: string; timing: string }>(
      `select t.tgname, case when (t.tgtype & 1) = 0 then 'STATEMENT' else 'ROW' end as timing
       from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal`,
    );
    expect(trigger.rows.map((row) => row.tgname)).toStrictEqual(["on_auth_user_created"]);
    expect(trigger.rows[0]?.timing).toBe("ROW");

    const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select p.prosecdef, p.proconfig from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'handle_new_auth_user'`,
    );
    expect(fn.rows[0]?.prosecdef).toBe(true);
    expect(fn.rows[0]?.proconfig).toStrictEqual(['search_path=""']);
  });

  it("サインアップで users と user_profiles が同一UUIDで作られる", async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into auth.users (email) values ('provisioning@example.test') returning id",
    );
    const userId = rows[0]?.id;

    const provisioned = await db.query<{ users: string; profiles: string; profile_owner: string }>(
      `select
         (select count(*)::text from public.users where id = $1) as users,
         (select count(*)::text from public.user_profiles where id = $1) as profiles,
         (select owner_id::text from public.user_profiles where id = $1) as profile_owner`,
      [userId],
    );

    expect(provisioned.rows[0]).toStrictEqual({
      users: "1",
      profiles: "1",
      profile_owner: userId,
    });
  });

  it("auth.users の削除で users / user_profiles が CASCADE 削除される", async () => {
    const created = await db.query<{ id: string }>(
      "insert into auth.users (email) values ('cascade@example.test') returning id",
    );
    const userId = created.rows[0]?.id;

    await db.query("delete from auth.users where id = $1", [userId]);

    const remaining = await db.query<{ users: string; profiles: string }>(
      `select
         (select count(*)::text from public.users where id = $1) as users,
         (select count(*)::text from public.user_profiles where id = $1) as profiles`,
      [userId],
    );

    expect(remaining.rows[0]).toStrictEqual({ users: "0", profiles: "0" });
  });
});

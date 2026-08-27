// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

describe("users / user_profiles の RLS 分離 (実装仕様書 6.5節 / 9章)", () => {
  let db: PGlite;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    alice = await signUp(db, "alice@example.test");
    bob = await signUp(db, "bob@example.test");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("認証済み利用者は自分の users 行だけを参照できる", async () => {
    const visible = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>("select id from public.users"),
    );

    expect(visible.rows.map((row) => row.id)).toStrictEqual([alice]);
  });

  it("他利用者の users 行は owner_id を指定しても参照できない", async () => {
    const other = await asAuthenticated(db, alice, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from public.users where id = $1",
        [bob],
      ),
    );

    expect(other.rows[0]?.count).toBe("0");
  });

  it("認証済み利用者は自分の user_profiles 行だけを参照できる", async () => {
    const visible = await asAuthenticated(db, bob, async () =>
      db.query<{ owner_id: string }>("select owner_id from public.user_profiles"),
    );

    expect(visible.rows.map((row) => row.owner_id)).toStrictEqual([bob]);
  });

  it("他利用者の user_profiles は更新できない（0件更新になる）", async () => {
    const updated = await asAuthenticated(db, alice, async () =>
      db.query<{ id: string }>(
        "update public.user_profiles set display_name = $1 where owner_id = $2 returning id",
        ["taken over", bob],
      ),
    );
    expect(updated.rows).toStrictEqual([]);

    const untouched = await db.query<{ display_name: string | null }>(
      "select display_name from public.user_profiles where id = $1",
      [bob],
    );
    expect(untouched.rows[0]?.display_name).toBeNull();
  });

  it("自分の user_profiles は更新できる", async () => {
    const updated = await asAuthenticated(db, alice, async () =>
      db.query<{ display_name: string | null }>(
        "update public.user_profiles set display_name = $1 where owner_id = $2 returning display_name",
        ["アリス", alice],
      ),
    );

    expect(updated.rows[0]?.display_name).toBe("アリス");
  });

  it("users の UPDATE は locale / timezone / last_seen_at に限定される", async () => {
    const allowed = await asAuthenticated(db, alice, async () =>
      db.query<{ timezone: string; locale: string }>(
        "update public.users set timezone = $1, locale = $2 where id = $3 returning timezone, locale",
        ["Asia/Tokyo", "ja", alice],
      ),
    );
    expect(allowed.rows[0]).toStrictEqual({ timezone: "Asia/Tokyo", locale: "ja" });

    const denied = await asAuthenticated(db, alice, async () =>
      expectRejection(() =>
        db.query("update public.users set status = 'active' where id = $1", [alice]),
      ),
    );
    expect(denied).toMatch(/permission denied/i);
  });

  it("authenticated は users を INSERT / DELETE できない", async () => {
    const insertError = await asAuthenticated(db, alice, async () =>
      expectRejection(() =>
        db.query("insert into public.users (id, owner_id) values ($1, $1)", [alice]),
      ),
    );
    expect(insertError).toMatch(/permission denied/i);

    const deleteError = await asAuthenticated(db, alice, async () =>
      expectRejection(() => db.query("delete from public.users where id = $1", [alice])),
    );
    expect(deleteError).toMatch(/permission denied/i);
  });

  it("匿名（未ログイン）は users / user_profiles へ一切アクセスできない", async () => {
    const usersError = await asAnon(db, async () =>
      expectRejection(() => db.query("select * from public.users")),
    );
    expect(usersError).toMatch(/permission denied/i);

    const profilesError = await asAnon(db, async () =>
      expectRejection(() => db.query("select * from public.user_profiles")),
    );
    expect(profilesError).toMatch(/permission denied/i);
  });

  it("ブラウザの公開キーが名乗るロールは service_role の権限を持たない", async () => {
    // service_role はブラウザへ渡さない（実装仕様書 6.5節 / 9.2節）。
    // ブラウザが名乗れるのは anon / authenticated のみで、どちらも service_role の
    // メンバーではないため、公開キー経由で service_role の権限へ到達できない。
    const membership = await db.query<{ role_name: string; has_service_role: boolean }>(
      `select r.rolname as role_name,
              pg_catalog.pg_has_role(r.rolname, 'service_role', 'usage') as has_service_role
       from pg_catalog.pg_roles r
       where r.rolname in ('anon', 'authenticated')
       order by r.rolname`,
    );

    expect(membership.rows).toStrictEqual([
      { role_name: "anon", has_service_role: false },
      { role_name: "authenticated", has_service_role: false },
    ]);
  });

  it("anon には users / user_profiles の権限が一切付与されていない", async () => {
    const grants = await db.query<{ count: string }>(
      `select count(*)::text as count from information_schema.role_table_grants
       where grantee = 'anon'
         and table_schema = 'public'
         and table_name in ('users', 'user_profiles')`,
    );
    expect(grants.rows[0]?.count).toBe("0");

    const policies = await db.query<{ count: string }>(
      `select count(*)::text as count from pg_policies
       where schemaname = 'public'
         and tablename in ('users', 'user_profiles')
         and 'anon' = any (roles)`,
    );
    expect(policies.rows[0]?.count).toBe("0");
  });

  it("anon には共通関数の EXECUTE が付与されていない", async () => {
    const { rows } = await db.query<{
      routine_name: string;
      anon: boolean;
      authenticated: boolean;
    }>(
      `select p.proname as routine_name,
              pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
       order by p.proname`,
    );

    expect(rows).toStrictEqual([
      { routine_name: "apply_owned_mutable_table_conventions", anon: false, authenticated: false },
      { routine_name: "handle_new_auth_user", anon: false, authenticated: false },
      { routine_name: "is_active_user", anon: false, authenticated: true },
      { routine_name: "storage_object_path_is_owned", anon: false, authenticated: true },
      { routine_name: "tg_owned_mutable_before_insert", anon: false, authenticated: false },
      { routine_name: "tg_owned_mutable_before_update", anon: false, authenticated: false },
    ]);
  });
});

describe("public.is_active_user() (実装仕様書 6.5節)", () => {
  let db: PGlite;
  let userId: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "status@example.test");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const setStatus = async (status: string): Promise<void> => {
    await db.query("update public.users set status = $1::public.user_status where id = $2", [
      status,
      userId,
    ]);
  };

  it("status = active のとき true を返す", async () => {
    const result = await asAuthenticated(db, userId, async () =>
      db.query<{ active: boolean }>("select public.is_active_user() as active"),
    );

    expect(result.rows[0]?.active).toBe(true);
  });

  it.each(["suspended", "health_data_erasure_pending", "deletion_pending"])(
    "status = %s のとき false を返し、自分の行も参照できなくなる",
    async (status) => {
      await setStatus(status);

      const result = await asAuthenticated(db, userId, async () => ({
        active: (await db.query<{ active: boolean }>("select public.is_active_user() as active"))
          .rows[0]?.active,
        users: (
          await db.query<{ count: string }>("select count(*)::text as count from public.users")
        ).rows[0]?.count,
        profiles: (
          await db.query<{ count: string }>(
            "select count(*)::text as count from public.user_profiles",
          )
        ).rows[0]?.count,
      }));

      expect(result).toStrictEqual({ active: false, users: "0", profiles: "0" });

      await setStatus("active");
    },
  );

  it("セッションが無い（auth.uid() が null）とき false を返す", async () => {
    const result = await db.query<{ active: boolean }>("select public.is_active_user() as active");

    expect(result.rows[0]?.active).toBe(false);
  });
});

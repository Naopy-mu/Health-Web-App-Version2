// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

describe("版番号・冪等性の共通パターン (実装仕様書 6.4節)", () => {
  let db: PGlite;
  let userId: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "versioning@example.test");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("可変公開テーブルが owner_id / row_version / client_mutation_id を持つ", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
         and column_name in ('row_version', 'client_mutation_id', 'owner_id')
       order by table_name, column_name`,
    );

    expect(rows).toStrictEqual([
      { table_name: "user_profiles", column_name: "client_mutation_id", data_type: "uuid" },
      { table_name: "user_profiles", column_name: "owner_id", data_type: "uuid" },
      { table_name: "user_profiles", column_name: "row_version", data_type: "bigint" },
      { table_name: "users", column_name: "client_mutation_id", data_type: "uuid" },
      { table_name: "users", column_name: "owner_id", data_type: "uuid" },
      { table_name: "users", column_name: "row_version", data_type: "bigint" },
    ]);
  });

  it("(owner_id, client_mutation_id) の NULL 除外一意インデックスが張られている", async () => {
    const { rows } = await db.query<{ tablename: string; indexdef: string }>(
      `select tablename, indexdef from pg_indexes
       where schemaname = 'public' and indexname like '%_owner_client_mutation_key'
       order by tablename`,
    );

    expect(rows.map((row) => row.tablename)).toStrictEqual(["user_profiles", "users"]);
    for (const row of rows) {
      expect(row.indexdef).toContain("CREATE UNIQUE INDEX");
      expect(row.indexdef).toContain("(owner_id, client_mutation_id)");
      expect(row.indexdef).toContain("WHERE (client_mutation_id IS NOT NULL)");
    }
  });

  it("INSERT トリガーが row_version = 1 とサーバー時刻を強制する", async () => {
    const created = await signUp(db, "forced-insert@example.test");

    const row = await db.query<{ row_version: string; created_is_recent: boolean }>(
      `select row_version::text as row_version,
              (created_at > now() - interval '1 minute') as created_is_recent
       from public.users where id = $1`,
      [created],
    );

    expect(row.rows[0]?.row_version).toBe("1");
    expect(row.rows[0]?.created_is_recent).toBe(true);
  });

  it("クライアントが row_version / created_at を詐称しても INSERT 時に上書きされる", async () => {
    const spoofed = await signUp(db, "spoofed@example.test");
    await db.query("delete from public.user_profiles where id = $1", [spoofed]);

    const inserted = await db.query<{ row_version: string; created_at: string }>(
      `insert into public.user_profiles (id, owner_id, row_version, created_at)
       values ($1, $1, 999, timestamptz '2000-01-01T00:00:00Z')
       returning row_version::text as row_version, created_at::text as created_at`,
      [spoofed],
    );

    expect(inserted.rows[0]?.row_version).toBe("1");
    expect(inserted.rows[0]?.created_at.startsWith("2000-01-01")).toBe(false);
  });

  it("UPDATE トリガーが row_version を加算し updated_at を更新する", async () => {
    const before = await db.query<{ row_version: string }>(
      "select row_version::text as row_version from public.user_profiles where id = $1",
      [userId],
    );

    await db.query("update public.user_profiles set display_name = $1 where id = $2", [
      "更新後",
      userId,
    ]);

    const after = await db.query<{ row_version: string; touched: boolean }>(
      `select row_version::text as row_version, (updated_at >= created_at) as touched
       from public.user_profiles where id = $1`,
      [userId],
    );

    expect(Number(after.rows[0]?.row_version)).toBe(Number(before.rows[0]?.row_version) + 1);
    expect(after.rows[0]?.touched).toBe(true);
  });

  it.each(["id", "owner_id", "created_at"])("UPDATE で %s の変更を拒否する", async (column) => {
    const value =
      column === "created_at"
        ? "timestamptz '2000-01-01T00:00:00Z'"
        : "'00000000-0000-0000-0000-0000000000ff'::uuid";

    const message = await expectRejection(() =>
      db.query(`update public.user_profiles set ${column} = ${value} where id = $1`, [userId]),
    );

    expect(message).toContain(`column "${column}" is immutable`);
  });

  it("楽観ロック: row_version 不一致の UPDATE は 0 件になる（HTTP 409 相当）", async () => {
    const current = await asAuthenticated(db, userId, async () =>
      db.query<{ row_version: string }>(
        "select row_version::text as row_version from public.user_profiles where owner_id = $1",
        [userId],
      ),
    );
    const expected = Number(current.rows[0]?.row_version);

    const stale = await asAuthenticated(db, userId, async () =>
      db.query<{ id: string }>(
        `update public.user_profiles set display_name = $1
         where id = $2 and owner_id = $2 and row_version = $3
         returning id`,
        ["競合", userId, expected - 1],
      ),
    );
    expect(stale.rows).toHaveLength(0);

    const fresh = await asAuthenticated(db, userId, async () =>
      db.query<{ id: string }>(
        `update public.user_profiles set display_name = $1
         where id = $2 and owner_id = $2 and row_version = $3
         returning id`,
        ["成功", userId, expected],
      ),
    );
    expect(fresh.rows).toHaveLength(1);
  });

  it("取り付け関数が列不足のテーブルを拒否する", async () => {
    await db.exec("create table public.tmp_bad (id uuid primary key, owner_id uuid not null);");

    const message = await expectRejection(() =>
      db.query("select public.apply_owned_mutable_table_conventions('public.tmp_bad'::regclass)"),
    );
    expect(message).toContain("missing required owned-mutable columns");

    await db.exec("drop table public.tmp_bad;");
  });

  it("取り付け関数が (id, owner_id) 候補キーの無いテーブルを拒否する", async () => {
    await db.exec(`create table public.tmp_no_key (
      id uuid primary key,
      owner_id uuid not null,
      client_mutation_id uuid,
      row_version bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );`);

    const message = await expectRejection(() =>
      db.query(
        "select public.apply_owned_mutable_table_conventions('public.tmp_no_key'::regclass)",
      ),
    );
    expect(message).toContain("unique (id, owner_id) candidate key");

    await db.exec("drop table public.tmp_no_key;");
  });
});

/**
 * 後続フェーズが機能テーブルを追加するときのテンプレート
 * （docs/database/table-conventions.md）が、そのまま動くことを検証する。
 * ここで作るテーブルはテスト内だけの一時テーブルで、migration には含めない。
 */
describe("機能テーブルのテンプレート検証 (実装仕様書 6.2節 / 6.4節)", () => {
  let db: PGlite;
  let owner: string;
  let stranger: string;

  const TEMPLATE_TABLE = `
    create table public.tmpl_entries (
      id                 uuid primary key default gen_random_uuid(),
      owner_id           uuid not null references public.users (id) on delete cascade,
      recorded_at        timestamptz not null default now(),
      note               text,
      client_mutation_id uuid,
      row_version        bigint not null default 1,
      created_at         timestamptz not null default now(),
      updated_at         timestamptz not null default now(),
      constraint tmpl_entries_id_owner_id_key unique (id, owner_id)
    );

    create table public.tmpl_entry_items (
      id                 uuid primary key default gen_random_uuid(),
      owner_id           uuid not null references public.users (id) on delete cascade,
      entry_id           uuid not null,
      label              text not null,
      client_mutation_id uuid,
      row_version        bigint not null default 1,
      created_at         timestamptz not null default now(),
      updated_at         timestamptz not null default now(),
      constraint tmpl_entry_items_id_owner_id_key unique (id, owner_id),
      constraint tmpl_entry_items_entry_fkey
        foreign key (entry_id, owner_id)
        references public.tmpl_entries (id, owner_id) on delete cascade
    );

    select public.apply_owned_mutable_table_conventions('public.tmpl_entries'::regclass);
    select public.apply_owned_mutable_table_conventions('public.tmpl_entry_items'::regclass);
  `;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    owner = await signUp(db, "template-owner@example.test");
    stranger = await signUp(db, "template-stranger@example.test");
    await db.exec(TEMPLATE_TABLE);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("同一所有者の client_mutation_id 重複を拒否し、別所有者では衝突しない", async () => {
    const mutationId = "3f6d0f4e-31e6-4a2c-9d9f-4d6f0d3f0a11";

    await db.query(
      "insert into public.tmpl_entries (owner_id, client_mutation_id) values ($1, $2)",
      [owner, mutationId],
    );

    const duplicate = await expectRejection(() =>
      db.query("insert into public.tmpl_entries (owner_id, client_mutation_id) values ($1, $2)", [
        owner,
        mutationId,
      ]),
    );
    expect(duplicate).toMatch(/duplicate key value/i);

    const otherOwner = await db.query<{ id: string }>(
      "insert into public.tmpl_entries (owner_id, client_mutation_id) values ($1, $2) returning id",
      [stranger, mutationId],
    );
    expect(otherOwner.rows).toHaveLength(1);
  });

  it("client_mutation_id が NULL の行は何度でも作れる（NULL除外一意）", async () => {
    await db.query("insert into public.tmpl_entries (owner_id) values ($1), ($1)", [owner]);

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from public.tmpl_entries where owner_id = $1 and client_mutation_id is null",
      [owner],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(2);
  });

  it("複合外部キーが他利用者の親への接続を拒否する", async () => {
    const parent = await db.query<{ id: string }>(
      "insert into public.tmpl_entries (owner_id) values ($1) returning id",
      [owner],
    );
    const parentId = parent.rows[0]?.id;

    const sameOwner = await db.query<{ id: string }>(
      "insert into public.tmpl_entry_items (owner_id, entry_id, label) values ($1, $2, $3) returning id",
      [owner, parentId, "ok"],
    );
    expect(sameOwner.rows).toHaveLength(1);

    const crossOwner = await expectRejection(() =>
      db.query(
        "insert into public.tmpl_entry_items (owner_id, entry_id, label) values ($1, $2, $3)",
        [stranger, parentId, "stolen"],
      ),
    );
    expect(crossOwner).toMatch(/tmpl_entry_items_entry_fkey/);
  });

  it("共通トリガーが row_version と不変列を制御する", async () => {
    const created = await db.query<{ id: string; row_version: string }>(
      `insert into public.tmpl_entries (owner_id, note, row_version)
       values ($1, 'テンプレート', 42)
       returning id, row_version::text as row_version`,
      [owner],
    );
    const entryId = created.rows[0]?.id;
    expect(created.rows[0]?.row_version).toBe("1");

    const updated = await db.query<{ row_version: string }>(
      "update public.tmpl_entries set note = $1 where id = $2 returning row_version::text as row_version",
      ["更新", entryId],
    );
    expect(updated.rows[0]?.row_version).toBe("2");

    const immutable = await expectRejection(() =>
      db.query("update public.tmpl_entries set owner_id = $1 where id = $2", [stranger, entryId]),
    );
    expect(immutable).toContain('column "owner_id" is immutable');
  });
});

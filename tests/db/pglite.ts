import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const repoUrl = new URL("../../", import.meta.url);
const migrationsDir = fileURLToPath(new URL("supabase/migrations/", repoUrl));
const shimPath = fileURLToPath(new URL("tests/db/supabase-shim.sql", repoUrl));

/** 実装仕様書 6章: migration ファイル名は `YYYYMMDDHHMMSS_<snake_case>.sql`。 */
export const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

export type MigrationFile = {
  readonly name: string;
  readonly sql: string;
};

/** `supabase/migrations/` の SQL をファイル名昇順（=適用順）で読み出す。 */
export function readMigrations(): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name), "utf8"),
    }));
}

/** Supabase 前提（ロール・auth・storage）を再現するテスト用シム。 */
export function readSupabaseShim(): string {
  return readFileSync(shimPath, "utf8");
}

/**
 * まっさらな PGlite へシムと全 migration を適用したデータベースを返す。
 * 「新規適用が成功すること」（実装仕様書 12章のDB検証）そのものの検証を兼ねる。
 */
export async function createMigratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readSupabaseShim());
  for (const migration of readMigrations()) {
    try {
      await db.exec(migration.sql);
    } catch (cause) {
      throw new Error(`migration failed: ${migration.name}`, { cause });
    }
  }
  return db;
}

/** Supabase Auth のサインアップ相当。`on_auth_user_created` の経路で利用者を作る。 */
export async function signUp(db: PGlite, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error(`failed to create auth user: ${email}`);
  }
  return id;
}

/** ブラウザの公開キー + セッション相当（role=authenticated, sub=<uid>）で実行する。 */
export async function asAuthenticated<T>(
  db: PGlite,
  userId: string,
  run: () => Promise<T>,
): Promise<T> {
  return withSessionContext(
    db,
    "authenticated",
    JSON.stringify({ sub: userId, role: "authenticated" }),
    run,
  );
}

/** ブラウザの公開キーのみ（未ログイン）相当で実行する。 */
export async function asAnon<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  return withSessionContext(db, "anon", JSON.stringify({ role: "anon" }), run);
}

async function withSessionContext<T>(
  db: PGlite,
  role: string,
  claims: string,
  run: () => Promise<T>,
): Promise<T> {
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await db.exec(`set role ${role};`);
  try {
    return await run();
  } finally {
    await db.exec("reset role;");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

/** PostgreSQL のエラーメッセージを取り出す（失敗を期待するテスト用）。 */
export async function expectRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

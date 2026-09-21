import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { readMigrations, readSupabaseShim } from "./pglite";

/**
 * 実 PostgreSQL（Docker コンテナ）へ `psql` で繋ぐテスト用ヘルパー。
 *
 * PGlite は接続が1本なので、2つのトランザクションを**本当に**並行させられない
 * （ロックの待ち合わせや、他トランザクションの未コミット行が見えないことを
 * 再現できない）。同時実行の不変条件は、独立した2本のセッションを持てる
 * 実 PostgreSQL で確かめる必要がある。
 *
 * ドライバ（`pg` など）を依存に足さず、コンテナ内の `psql` を
 * `docker exec -i` で常駐させて標準入出力で対話する。各文のあとに
 * `\echo` の目印を流し、目印が返ってきたら「その文が終わった」とみなす
 * （ロック待ちで止まっている間は目印が返らない）。
 *
 * 使い方は tests/README.md「実 PostgreSQL での同時実行テスト」を参照。
 */

/** 実 PostgreSQL を使うテストの接続先コンテナ名（未設定ならテストを飛ばす）。 */
export const RACE_PG_CONTAINER = process.env.RACE_PG_CONTAINER ?? "";

const PSQL_ARGS = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0", "-U", "postgres"] as const;

/** 1回きりの `psql` 実行（管理用: データベースの作成・削除、スキーマの適用）。 */
export function runPsql(database: string, sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      RACE_PG_CONTAINER,
      "psql",
      ...PSQL_ARGS,
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      database,
    ],
    { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed (${String(result.status)}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * シムが作る Supabase の組み込みロールはクラスタ全体の共有物なので、
 * データベースを作り直すたびに消しておく（前回の実行の残りで失敗しないように）。
 * 接続先は**このテスト専用の使い捨てコンテナ**であること（tests/README.md）。
 */
const SHIM_ROLES = ["anon", "authenticated", "service_role"] as const;

/** まっさらなデータベースを作り、シムと全 migration を適用する。 */
export function createMigratedPostgresDatabase(database: string): void {
  dropPostgresDatabase(database);
  runPsql("postgres", `create database ${database};`);
  const schema = [readSupabaseShim(), ...readMigrations().map((migration) => migration.sql)].join(
    "\n;\n",
  );
  runPsql(database, `set client_min_messages = warning;\n${schema}`);
}

export function dropPostgresDatabase(database: string): void {
  runPsql(
    "postgres",
    [
      `drop database if exists ${database} with (force);`,
      ...SHIM_ROLES.map((role) => `drop role if exists ${role};`),
    ].join("\n"),
  );
}

/** 1文の実行結果。`error` は `ERROR:` 行（無ければ null）。 */
export type StatementResult = {
  readonly output: string;
  readonly error: string | null;
};

/**
 * 常駐する `psql` セッション（＝独立した1本の接続）。
 * `send` は文を投げて結果の Promise を返す。ロック待ちで止まっていれば
 * Promise は解決しないまま残るので、相手側のコミット後に await すればよい。
 */
export class PsqlSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private readonly waiters = new Map<string, (text: string) => void>();

  constructor(
    database: string,
    readonly applicationName: string,
  ) {
    // stderr を stdout へ寄せ、エラーと目印の前後関係を1本の流れで保つ。
    this.child = spawn("docker", [
      "exec",
      "-i",
      "-e",
      `PGAPPNAME=${applicationName}`,
      RACE_PG_CONTAINER,
      "sh",
      "-c",
      `psql ${PSQL_ARGS.join(" ")} -d ${database} 2>&1`,
    ]);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  private drain(): void {
    for (const [marker, resolve] of this.waiters) {
      const index = this.buffer.indexOf(marker);
      if (index === -1) {
        continue;
      }
      const text = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + marker.length);
      this.waiters.delete(marker);
      resolve(text);
    }
  }

  send(sql: string): Promise<StatementResult> {
    this.sequence += 1;
    const marker = `__${this.applicationName}_done_${String(this.sequence)}__`;
    const done = new Promise<StatementResult>((resolve) => {
      this.waiters.set(marker, (text) => {
        const errorLine = text.split("\n").find((line) => line.includes("ERROR:"));
        resolve({ output: text.trim(), error: errorLine?.trim() ?? null });
      });
    });
    this.child.stdin.write(`${sql.trim()}\n\\echo ${marker}\n`);
    return done;
  }

  /** 認証済み利用者として明示トランザクションを開く（PostgREST の1リクエスト相当）。 */
  async beginAs(userId: string): Promise<void> {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    for (const sql of [
      "begin;",
      `select set_config('request.jwt.claims', '${claims}', true);`,
      "set local role authenticated;",
    ]) {
      const result = await this.send(sql);
      if (result.error !== null) {
        throw new Error(`failed to open the transaction: ${result.error}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.send("rollback;").catch(() => undefined);
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
    });
  }
}

/**
 * `session` の文が完了した（Promise が解決した）か、ロック待ちに入ったかの
 * どちらかになるまで待つ。前者なら "finished"、後者なら "blocked"。
 *
 * どちらにもならないまま相手側をコミットすると、「相手のコミット後に
 * 文が走った」だけの直列実行になり、競合を再現できない。
 */
export async function settleOrBlock(
  database: string,
  session: PsqlSession,
  pending: Promise<StatementResult>,
): Promise<"finished" | "blocked"> {
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (finished) {
      return "finished";
    }
    const waiting = runPsql(
      database,
      `select count(*) from pg_stat_activity
        where application_name = '${session.applicationName}'
          and wait_event_type = 'Lock';`,
    ).trim();
    if (finished) {
      return "finished";
    }
    if (waiting === "1") {
      return "blocked";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${session.applicationName}: neither finished nor blocked within 15s`);
}

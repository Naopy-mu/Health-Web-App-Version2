// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

const OBJECT_UUID = "8c4b1a6f-0a1c-4a2f-9f2b-2c9a3f5b7d10";

describe("Storage 基盤 (実装仕様書 6.6節)", () => {
  let db: PGlite;
  let owner: string;
  let stranger: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    owner = await signUp(db, "storage-owner@example.test");
    stranger = await signUp(db, "storage-stranger@example.test");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("非公開バケットが 10MiB / 画像MIME限定で作成されている", async () => {
    const { rows } = await db.query<{
      id: string;
      public: boolean;
      file_size_limit: string;
      allowed_mime_types: string[];
    }>(
      `select id, public, file_size_limit::text as file_size_limit, allowed_mime_types
       from storage.buckets order by id`,
    );

    expect(rows.map((row) => row.id)).toStrictEqual(["food-images-private", "health-images"]);
    for (const row of rows) {
      expect(row.public).toBe(false);
      expect(row.file_size_limit).toBe("10485760");
      expect(row.allowed_mime_types).toStrictEqual([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
      ]);
    }
  });

  it("storage.objects の RLS が有効で anon 向けポリシーが無い", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'storage.objects'::regclass",
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);

    const policies = await db.query<{ policyname: string; roles: string[] }>(
      "select policyname, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname",
    );
    expect(policies.rows.map((row) => row.policyname)).toStrictEqual([
      "food-images-private_delete_own",
      "food-images-private_insert_own",
      "food-images-private_select_own",
      "food-images-private_update_own",
      "health-images_delete_own",
      "health-images_insert_own",
      "health-images_select_own",
      "health-images_update_own",
    ]);
    for (const row of policies.rows) {
      expect(row.roles).toStrictEqual(["authenticated"]);
    }
  });

  it.each([["health-images"], ["food-images-private"]])(
    "%s: 所有者は <auth.uid()>/<uuid>.<拡張子> のパスへ書き込める",
    async (bucket) => {
      const inserted = await asAuthenticated(db, owner, async () =>
        db.query<{ name: string }>(
          "insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3) returning name",
          [bucket, `${owner}/${OBJECT_UUID}.jpg`, owner],
        ),
      );

      expect(inserted.rows[0]?.name).toBe(`${owner}/${OBJECT_UUID}.jpg`);
    },
  );

  it("匿名は非公開バケットのオブジェクトを一切参照できない", async () => {
    const visible = await asAnon(db, async () =>
      db.query<{ count: string }>("select count(*)::text as count from storage.objects"),
    );

    // anon 向けポリシーが無いため、RLS により 0 件になる。
    expect(visible.rows[0]?.count).toBe("0");
  });

  it("所有者以外は他利用者のオブジェクトを参照・削除できない", async () => {
    const visible = await asAuthenticated(db, stranger, async () =>
      db.query<{ count: string }>("select count(*)::text as count from storage.objects"),
    );
    expect(visible.rows[0]?.count).toBe("0");

    const deleted = await asAuthenticated(db, stranger, async () =>
      db.query<{ name: string }>("delete from storage.objects where name like $1 returning name", [
        `${owner}/%`,
      ]),
    );
    expect(deleted.rows).toHaveLength(0);

    const stillThere = await db.query<{ count: string }>(
      "select count(*)::text as count from storage.objects where name like $1",
      [`${owner}/%`],
    );
    expect(Number(stillThere.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("所有者UUID配下でも規定外のパスは拒否される", async () => {
    const invalidPaths = [
      `${owner}/not-a-uuid.jpg`,
      `${owner}/${OBJECT_UUID}.gif`,
      `${owner}/nested/${OBJECT_UUID}.jpg`,
      `${OBJECT_UUID}.jpg`,
      `${stranger}/${OBJECT_UUID}.jpg`,
    ];

    for (const path of invalidPaths) {
      const message = await asAuthenticated(db, owner, async () =>
        expectRejection(() =>
          db.query("insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)", [
            "health-images",
            path,
            owner,
          ]),
        ),
      );
      expect(message, path).toMatch(/row-level security/i);
    }
  });

  it("許可した拡張子だけがパス規則を満たす", async () => {
    const { rows } = await db.query<{ extension: string; allowed: boolean }>(
      `select extension,
              public.storage_object_path_is_owned(
                $1 || '/' || $2 || '.' || extension, $1::uuid
              ) as allowed
       from unnest(array['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'svg', 'exe']) as extension`,
      [owner, OBJECT_UUID],
    );

    expect(Object.fromEntries(rows.map((row) => [row.extension, row.allowed]))).toStrictEqual({
      jpg: true,
      jpeg: true,
      png: true,
      webp: true,
      heic: true,
      heif: true,
      gif: false,
      svg: false,
      exe: false,
    });
  });

  it("status が active でない利用者は自分のオブジェクトにも到達できない", async () => {
    await db.query("update public.users set status = 'suspended' where id = $1", [owner]);

    const visible = await asAuthenticated(db, owner, async () =>
      db.query<{ count: string }>("select count(*)::text as count from storage.objects"),
    );
    expect(visible.rows[0]?.count).toBe("0");

    await db.query("update public.users set status = 'active' where id = $1", [owner]);
  });
});

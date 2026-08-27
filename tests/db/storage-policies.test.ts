// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asAnon,
  asAuthenticated,
  createMigratedDatabase,
  expectRejection,
  readMigrations,
  signUp,
} from "./pglite";

const OBJECT_UUID = "8c4b1a6f-0a1c-4a2f-9f2b-2c9a3f5b7d10";

describe("Storage 基盤 (実装仕様書 6.6節 / 5.8節)", () => {
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

  it("非公開バケットがバケットごとの上限・MIME制限で作成されている", async () => {
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

    // 実装仕様書 5.8節: 食事画像は 6MB 以下、JPEG/PNG/WebP のみ（HEIC/HEIF 非対応）。
    expect(rows[0]).toStrictEqual({
      id: "food-images-private",
      public: false,
      file_size_limit: "6000000",
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp"],
    });

    // 実装仕様書 6.6節: health-images は 10MiB、HEIC/HEIF を許可する。
    expect(rows[1]).toStrictEqual({
      id: "health-images",
      public: false,
      file_size_limit: "10485760",
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    });
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

  it("migration が storage スキーマのテーブルを ALTER しない", () => {
    // 実 Supabase では storage.objects の所有者は supabase_storage_admin であり、
    // migration からの `alter table storage.objects ...` は 42501 で失敗する。
    // RLS は Supabase 側で既定有効なので、migration はポリシー作成だけを行う。
    for (const migration of readMigrations()) {
      const statements = migration.sql.replace(/--[^\n]*/g, "");
      expect(statements, migration.name).not.toMatch(/alter\s+table\s+storage\./i);
    }
  });

  it("storage.objects.owner_id が実 Supabase と同じ text 型である", async () => {
    const { rows } = await db.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner_id'`,
    );

    expect(rows[0]?.data_type).toBe("text");
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

  it("パスが正しくても owner_id が一致しない行は書き込めない", async () => {
    // 実装仕様書 6.6節: パスとメタデータ行の双方で所有者を検査する。
    for (const ownerId of [stranger, null]) {
      const message = await asAuthenticated(db, owner, async () =>
        expectRejection(() =>
          db.query("insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)", [
            "health-images",
            `${owner}/${OBJECT_UUID}.png`,
            ownerId,
          ]),
        ),
      );
      expect(message, String(ownerId)).toMatch(/row-level security/i);
    }
  });

  it("owner_id が他利用者の行はパスが自分配下でも参照・更新・削除できない", async () => {
    // Storage API 側で owner_id だけが差し替えられた行を想定し、RLS を迂回する
    // 所有者接続（service_role 相当）で直接投入する。
    const name = `${owner}/1f0f6d3c-1b6d-4a2e-8f7a-2b6d4c8e9a01.jpg`;
    await db.query("insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)", [
      "health-images",
      name,
      stranger,
    ]);

    const visible = await asAuthenticated(db, owner, async () =>
      db.query<{ count: string }>(
        "select count(*)::text as count from storage.objects where name = $1",
        [name],
      ),
    );
    expect(visible.rows[0]?.count).toBe("0");

    const updated = await asAuthenticated(db, owner, async () =>
      db.query<{ name: string }>(
        "update storage.objects set updated_at = now() where name = $1 returning name",
        [name],
      ),
    );
    expect(updated.rows).toHaveLength(0);

    const deleted = await asAuthenticated(db, owner, async () =>
      db.query<{ name: string }>("delete from storage.objects where name = $1 returning name", [
        name,
      ]),
    );
    expect(deleted.rows).toHaveLength(0);

    await db.query("delete from storage.objects where name = $1", [name]);
  });

  it("UPDATE で owner_id やパスを他利用者のものへ移し替えられない", async () => {
    const name = `${owner}/2c1d7e4a-3b8c-4d5e-9f10-5a6b7c8d9e02.png`;
    await asAuthenticated(db, owner, async () =>
      db.query("insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)", [
        "health-images",
        name,
        owner,
      ]),
    );

    const rejections = [
      await asAuthenticated(db, owner, async () =>
        expectRejection(() =>
          db.query("update storage.objects set owner_id = $1 where name = $2", [stranger, name]),
        ),
      ),
      await asAuthenticated(db, owner, async () =>
        expectRejection(() =>
          db.query("update storage.objects set name = $1 where name = $2", [
            `${stranger}/${OBJECT_UUID}.png`,
            name,
          ]),
        ),
      ),
    ];

    for (const message of rejections) {
      expect(message).toMatch(/row-level security/i);
    }

    await db.query("delete from storage.objects where name = $1", [name]);
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

  it("food-images-private は HEIC/HEIF のパスを拒否する", async () => {
    // 実装仕様書 5.8節: 食事画像は HEIC/HEIF 非対応。
    for (const extension of ["heic", "heif"]) {
      const message = await asAuthenticated(db, owner, async () =>
        expectRejection(() =>
          db.query("insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, $3)", [
            "food-images-private",
            `${owner}/3d2e8f5b-4c9d-4e6f-a021-6b7c8d9e0a03.${extension}`,
            owner,
          ]),
        ),
      );
      expect(message, extension).toMatch(/row-level security/i);
    }
  });

  it("許可した拡張子だけがパス規則を満たす", async () => {
    const { rows } = await db.query<{
      extension: string;
      health_images: boolean;
      food_images: boolean;
    }>(
      `select extension,
              public.storage_object_path_is_owned(
                $1 || '/' || $2 || '.' || extension,
                $1::uuid,
                array['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
              ) as health_images,
              public.storage_object_path_is_owned(
                $1 || '/' || $2 || '.' || extension,
                $1::uuid,
                array['jpg', 'jpeg', 'png', 'webp']
              ) as food_images
       from unnest(array['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'svg', 'exe']) as extension`,
      [owner, OBJECT_UUID],
    );

    expect(
      Object.fromEntries(rows.map((row) => [row.extension, [row.health_images, row.food_images]])),
    ).toStrictEqual({
      jpg: [true, true],
      jpeg: [true, true],
      png: [true, true],
      webp: [true, true],
      heic: [true, false],
      heif: [true, false],
      gif: [false, false],
      svg: [false, false],
      exe: [false, false],
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

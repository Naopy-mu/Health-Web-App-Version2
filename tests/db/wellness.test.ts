// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_BEVERAGE_TYPES, DEFAULT_SYMPTOM_TYPES } from "@/features/wellness/defaults";
import {
  calculateSleepMinutes,
  calculateTimeInBedMinutes,
  normalizeHydrationAmount,
} from "@/features/wellness/units";

import { asAuthenticated, createMigratedDatabase, expectRejection, signUp } from "./pglite";

/**
 * 睡眠・水分・体調のスキーマ契約（実装仕様書 5.5節 / 6.1〜6.4節）。
 *
 * PGlite へ全 migration を新規適用したうえで、
 *   - 共通テンプレート（row_version / client_mutation_id / 楽観ロック）の取り付け
 *   - 既定カタログと TypeScript 側の定数の一致
 *   - 生成列（睡眠時間・ml 正規化）が TypeScript の計算と一致すること
 *   - 実装仕様書 5.5節の値域・順序の制約
 *   - 既定種別の偽装・改ざん防止
 *   - 冪等キーの適用結果ログ
 * を確認する。RLS 分離は `wellness-rls.test.ts`、冪等再送は
 * `wellness-idempotency.test.ts` が受け持つ。
 */

const WELLNESS_OWNED_TABLES = [
  "beverage_types",
  "symptom_types",
  "sleep_entries",
  "sleep_goals",
  "hydration_entries",
  "hydration_goals",
  "condition_entries",
  "condition_entry_symptoms",
] as const;

describe("睡眠・水分・体調のスキーマ (実装仕様書 5.5節)", () => {
  let db: PGlite;
  let userId: string;
  let waterTypeId: string;
  let headacheTypeId: string;

  const asUser = async <T>(run: () => Promise<T>): Promise<T> => asAuthenticated(db, userId, run);

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "wellness@example.test");

    await asUser(async () => {
      await db.query("select public.seed_default_beverage_types()");
      await db.query("select public.seed_default_symptom_types()");
    });

    const water = await db.query<{ id: string }>(
      "select id from public.beverage_types where owner_id = $1 and beverage_key = 'water'",
      [userId],
    );
    waterTypeId = water.rows[0]?.id ?? "";

    const headache = await db.query<{ id: string }>(
      "select id from public.symptom_types where owner_id = $1 and symptom_key = 'headache'",
      [userId],
    );
    headacheTypeId = headache.rows[0]?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /* ------------------------------------------------------------------ */
  /* 共通テンプレート（docs/database/table-conventions.md）              */
  /* ------------------------------------------------------------------ */

  it("8テーブルすべてに共通テンプレートが取り付けられている", async () => {
    for (const table of WELLNESS_OWNED_TABLES) {
      const { rows: indexes } = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = $1",
        [table],
      );
      expect(
        indexes.some((index) => index.indexname.endsWith("_owner_client_mutation_key")),
        `${table} に冪等性インデックスが無い`,
      ).toBe(true);

      const { rows: triggers } = await db.query<{ tgname: string }>(
        `select t.tgname from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where c.relname = $1 and not t.tgisinternal`,
        [table],
      );
      const names = triggers.map((trigger) => trigger.tgname);
      expect(names.some((name) => name.endsWith("_owned_before_insert"))).toBe(true);
      expect(names.some((name) => name.endsWith("_owned_before_update"))).toBe(true);
    }
  });

  it("(id, owner_id) の候補キーを全テーブルが持つ（複合外部キーの参照先）", async () => {
    for (const table of WELLNESS_OWNED_TABLES) {
      const { rows } = await db.query<{ count: string }>(
        `select count(*)::text as count
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
          where c.relname = $1
            and con.contype in ('p', 'u')
            and (
              select array_agg(a.attname::text order by a.attname::text)
                from pg_attribute a
               where a.attrelid = con.conrelid and a.attnum = any (con.conkey)
            ) = array['id', 'owner_id']`,
        [table],
      );
      expect(Number(rows[0]?.count ?? 0), `${table} に (id, owner_id) が無い`).toBeGreaterThan(0);
    }
  });

  it("row_version はサーバーだけが進め、id / owner_id は変更できない", async () => {
    const created = await asUser(async () =>
      db.query<{ id: string; row_version: string }>(
        `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date, row_version)
         values ($1, 420, date '2026-01-01', 999) returning id, row_version::text as row_version`,
        [userId],
      ),
    );
    // クライアントが送った row_version は無視され、必ず 1 から始まる。
    expect(created.rows[0]?.row_version).toBe("1");

    const goalId = created.rows[0]?.id ?? "";
    const updated = await asUser(async () =>
      db.query<{ row_version: string }>(
        "update public.sleep_goals set target_sleep_minutes = 400 where id = $1 returning row_version::text as row_version",
        [goalId],
      ),
    );
    expect(updated.rows[0]?.row_version).toBe("2");

    const message = await expectRejection(() =>
      asUser(async () =>
        db.query("update public.sleep_goals set id = gen_random_uuid() where id = $1", [goalId]),
      ),
    );
    expect(message).toContain('column "id" is immutable');

    await asUser(async () => db.query("delete from public.sleep_goals where id = $1", [goalId]));
  });

  /* ------------------------------------------------------------------ */
  /* 既定カタログ（実装仕様書 5.5節）                                    */
  /* ------------------------------------------------------------------ */

  it("既定の飲み物10種が TypeScript 側の定数と一致する", async () => {
    const { rows } = await db.query<{
      beverage_key: string;
      display_name: string;
      default_unit: string;
      default_amount: string;
      contains_caffeine: boolean;
      contains_alcohol: boolean;
      sort_order: number;
    }>(
      `select beverage_key, display_name, default_unit, default_amount::text as default_amount,
              contains_caffeine, contains_alcohol, sort_order
         from public.beverage_types
        where owner_id = $1 and is_default
        order by sort_order`,
      [userId],
    );

    expect(rows).toHaveLength(10);
    expect(
      rows.map((row) => ({
        beverageKey: row.beverage_key,
        displayName: row.display_name,
        defaultUnit: row.default_unit,
        defaultAmount: Number(row.default_amount),
        containsCaffeine: row.contains_caffeine,
        containsAlcohol: row.contains_alcohol,
        sortOrder: Number(row.sort_order),
      })),
    ).toEqual([...DEFAULT_BEVERAGE_TYPES]);
  });

  it("既定の症状13種が TypeScript 側の定数と一致する", async () => {
    const { rows } = await db.query<{
      symptom_key: string;
      display_name: string;
      sort_order: number;
    }>(
      `select symptom_key, display_name, sort_order
         from public.symptom_types
        where owner_id = $1 and is_default
        order by sort_order`,
      [userId],
    );

    expect(rows).toHaveLength(13);
    expect(
      rows.map((row) => ({
        symptomKey: row.symptom_key,
        displayName: row.display_name,
        sortOrder: Number(row.sort_order),
      })),
    ).toEqual([...DEFAULT_SYMPTOM_TYPES]);
  });

  it("seed は何度呼んでも増えない（冪等）", async () => {
    await asUser(async () => {
      await db.query("select public.seed_default_beverage_types()");
      await db.query("select public.seed_default_symptom_types()");
    });

    const { rows } = await db.query<{ beverages: string; symptoms: string }>(
      `select
         (select count(*)::text from public.beverage_types where owner_id = $1) as beverages,
         (select count(*)::text from public.symptom_types where owner_id = $1) as symptoms`,
      [userId],
    );
    expect(rows[0]?.beverages).toBe("10");
    expect(rows[0]?.symptoms).toBe("13");
  });

  it("seed は既定種別の内容をカタログへ正規化する", async () => {
    // 既定種別はガードトリガーが守っているため、通常の経路では書き換えられない。
    // 「カタログ側が更新された（＝DBの行が古い）」状況を作るため、seed と同じ
    // 目印（GUC）を立てて表示名をずらしてから seed を呼ぶ。
    await db.query("select set_config('app.wellness_seed', 'on', false)");
    await db.query(
      "update public.beverage_types set display_name = '旧・水' where owner_id = $1 and beverage_key = 'water'",
      [userId],
    );
    await db.query("select set_config('app.wellness_seed', 'off', false)");

    await asUser(async () => db.query("select public.seed_default_beverage_types()"));

    const { rows } = await db.query<{ display_name: string }>(
      "select display_name from public.beverage_types where owner_id = $1 and beverage_key = 'water'",
      [userId],
    );
    expect(rows[0]?.display_name).toBe("水");
  });

  /* ------------------------------------------------------------------ */
  /* 既定種別の保護（実装仕様書 5.5節 / 9.2節）                          */
  /* ------------------------------------------------------------------ */

  it("既定カタログのキーをカスタム種別が名乗れない（既定種別の偽装防止）", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.beverage_types (owner_id, beverage_key, display_name, default_unit)
           values ($1, 'coffee', '偽コーヒー', 'ml')`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("reserved for the default wellness catalog");
  });

  it("authenticated は is_default を書けない（列レベル権限）", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.symptom_types (owner_id, symptom_key, display_name, is_default)
           values ($1, 'eye_strain', '目の疲れ', true)`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("permission denied");
  });

  it("既定種別の行は authenticated から UPDATE できない", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          "update public.beverage_types set display_name = '偽装' where owner_id = $1 and beverage_key = 'water'",
          [userId],
        ),
      ),
    );
    expect(message).toContain("can only be modified by the wellness seed functions");
  });

  it("既定種別はアーカイブできない（ガードトリガーと CHECK 制約の二重）", async () => {
    // 経路1: 通常の UPDATE はガードトリガーが先に拒否する。
    const guarded = await expectRejection(() =>
      asUser(async () =>
        db.query(
          "update public.beverage_types set archived_at = now() where owner_id = $1 and beverage_key = 'water'",
          [userId],
        ),
      ),
    );
    expect(guarded).toContain("cannot be archived");

    // 経路2: seed の目印を立ててトリガーを通しても、CHECK 制約が最後に拒否する。
    await db.query("select set_config('app.wellness_seed', 'on', false)");
    const checked = await expectRejection(() =>
      db.query(
        "update public.beverage_types set archived_at = now() where owner_id = $1 and beverage_key = 'water'",
        [userId],
      ),
    );
    await db.query("select set_config('app.wellness_seed', 'off', false)");
    expect(checked).toContain("beverage_types_default_not_archived");
  });

  it("カスタム症状種別は30件まで", async () => {
    const capUser = await signUp(db, "symptom-cap@example.test");
    await asAuthenticated(db, capUser, async () => {
      await db.query("select public.seed_default_symptom_types()");
      for (let index = 0; index < 30; index += 1) {
        await db.query(
          `insert into public.symptom_types (owner_id, symptom_key, display_name)
           values ($1, $2, $3)`,
          [capUser, `custom_${index}`, `カスタム${index}`],
        );
      }
    });

    const message = await expectRejection(() =>
      asAuthenticated(db, capUser, async () =>
        db.query(
          `insert into public.symptom_types (owner_id, symptom_key, display_name)
           values ($1, 'custom_over', '超過')`,
          [capUser],
        ),
      ),
    );
    expect(message).toContain("limited to 30 per owner");
  });

  /* ------------------------------------------------------------------ */
  /* 睡眠（実装仕様書 5.5節）                                            */
  /* ------------------------------------------------------------------ */

  it("睡眠時間・拘束時間の生成列が TypeScript の計算と一致する", async () => {
    const bedAt = "2026-09-01T22:30:00Z";
    const sleepAt = "2026-09-01T23:00:00Z";
    const wakeAt = "2026-09-02T06:30:00Z";
    const outOfBedAt = "2026-09-02T06:45:00Z";

    const { rows } = await asUser(async () =>
      db.query<{ sleep_minutes: number; time_in_bed_minutes: number }>(
        `insert into public.sleep_entries
           (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at, awake_minutes)
         values ($1, 'night', $2, $3, $4, $5, 25)
         returning sleep_minutes, time_in_bed_minutes`,
        [userId, bedAt, sleepAt, wakeAt, outOfBedAt],
      ),
    );

    expect(Number(rows[0]?.sleep_minutes)).toBe(calculateSleepMinutes(sleepAt, wakeAt, 25));
    expect(Number(rows[0]?.time_in_bed_minutes)).toBe(calculateTimeInBedMinutes(bedAt, outOfBedAt));
  });

  it("就床≦入眠＜起床≦離床 を満たさない値を拒否する", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.sleep_entries
             (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at)
           values ($1, 'nap', timestamptz '2026-09-05T14:00:00Z', timestamptz '2026-09-05T13:00:00Z',
                   timestamptz '2026-09-05T15:00:00Z', timestamptz '2026-09-05T15:10:00Z')`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("sleep_entries_chronology");
  });

  it("24時間を超える睡眠を拒否する", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.sleep_entries
             (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at)
           values ($1, 'other', timestamptz '2026-09-06T00:00:00Z', timestamptz '2026-09-06T01:00:00Z',
                   timestamptz '2026-09-07T00:30:00Z', timestamptz '2026-09-07T00:30:00Z')`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("sleep_entries_within_24_hours");
  });

  it("覚醒時間が睡眠時間以上の値を拒否する", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.sleep_entries
             (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at, awake_minutes)
           values ($1, 'nap', timestamptz '2026-09-07T14:00:00Z', timestamptz '2026-09-07T14:00:00Z',
                   timestamptz '2026-09-07T14:30:00Z', timestamptz '2026-09-07T14:30:00Z', 30)`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("sleep_entries_awake_shorter_than_sleep");
  });

  it("同一の所有者・種別・入眠日時の重複登録を防ぐ", async () => {
    const insert = () =>
      asUser(async () =>
        db.query(
          `insert into public.sleep_entries
             (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at)
           values ($1, 'nap', timestamptz '2026-09-08T14:00:00Z', timestamptz '2026-09-08T14:00:00Z',
                   timestamptz '2026-09-08T14:30:00Z', timestamptz '2026-09-08T14:30:00Z')`,
          [userId],
        ),
      );

    await insert();
    const message = await expectRejection(insert);
    expect(message).toContain("sleep_entries_owner_kind_sleep_at_key");
  });

  it("中途覚醒回数・覚醒時間・質・起床時の感覚の値域を守る", async () => {
    const insertWith = (columns: string, values: string) =>
      expectRejection(() =>
        asUser(async () =>
          db.query(
            `insert into public.sleep_entries
               (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at, ${columns})
             values ($1, 'other', timestamptz '2026-09-09T22:00:00Z', timestamptz '2026-09-09T22:00:00Z',
                     timestamptz '2026-09-10T06:00:00Z', timestamptz '2026-09-10T06:00:00Z', ${values})`,
            [userId],
          ),
        ),
      );

    expect(await insertWith("awakenings_count", "31")).toContain("sleep_entries_awakenings_range");
    expect(await insertWith("awake_minutes", "721")).toContain("sleep_entries_awake_minutes_range");
    expect(await insertWith("quality", "6")).toContain("sleep_entries_quality_range");
    expect(await insertWith("morning_feeling", "0")).toContain(
      "sleep_entries_morning_feeling_range",
    );
  });

  /* ------------------------------------------------------------------ */
  /* 水分（実装仕様書 5.5節 / 6.3節）                                    */
  /* ------------------------------------------------------------------ */

  it("ml 正規化の生成列が TypeScript の計算と一致する", async () => {
    const cases = [
      { unit: "ml" as const, amount: 200 },
      { unit: "l" as const, amount: 1.5 },
      { unit: "us_fl_oz" as const, amount: 8 },
    ];

    for (const [index, testCase] of cases.entries()) {
      const recordedAt = `2026-09-1${index}T09:00:00Z`;
      const { rows } = await asUser(async () =>
        db.query<{ amount_ml: string }>(
          `insert into public.hydration_entries
             (owner_id, beverage_type_id, recorded_at, unit, amount)
           values ($1, $2, $3, $4, $5) returning amount_ml::text as amount_ml`,
          [userId, waterTypeId, recordedAt, testCase.unit, testCase.amount],
        ),
      );
      expect(Number(rows[0]?.amount_ml)).toBe(
        normalizeHydrationAmount(testCase.amount, testCase.unit),
      );
    }
  });

  it("量は0超10,000以下", async () => {
    for (const amount of [0, 10000.001]) {
      const message = await expectRejection(() =>
        asUser(async () =>
          db.query(
            `insert into public.hydration_entries
               (owner_id, beverage_type_id, recorded_at, unit, amount)
             values ($1, $2, now(), 'ml', $3)`,
            [userId, waterTypeId, amount],
          ),
        ),
      );
      expect(message).toContain("hydration_entries_amount_range");
    }
  });

  it("同一の所有者・飲み物種別・記録日時の重複登録を防ぐ", async () => {
    const insert = () =>
      asUser(async () =>
        db.query(
          `insert into public.hydration_entries
             (owner_id, beverage_type_id, recorded_at, unit, amount)
           values ($1, $2, timestamptz '2026-09-20T09:00:00Z', 'ml', 200)`,
          [userId, waterTypeId],
        ),
      );

    await insert();
    const message = await expectRejection(insert);
    expect(message).toContain("hydration_entries_owner_type_recorded_at_key");
  });

  it("アーカイブ済みの飲み物種別へは新規登録できない", async () => {
    const custom = await asUser(async () =>
      db.query<{ id: string }>(
        `insert into public.beverage_types (owner_id, beverage_key, display_name, default_unit)
         values ($1, 'hot_water', '白湯', 'ml') returning id`,
        [userId],
      ),
    );
    const typeId = custom.rows[0]?.id ?? "";

    await asUser(async () =>
      db.query("update public.beverage_types set archived_at = now() where id = $1", [typeId]),
    );

    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.hydration_entries
             (owner_id, beverage_type_id, recorded_at, unit, amount)
           values ($1, $2, now(), 'ml', 100)`,
          [userId, typeId],
        ),
      ),
    );
    expect(message).toContain("is archived");
  });

  /* ------------------------------------------------------------------ */
  /* 体調（実装仕様書 5.5節）                                            */
  /* ------------------------------------------------------------------ */

  it("スコアは0〜10、体温は30〜45℃", async () => {
    const insertWith = (column: string, value: string) =>
      expectRejection(() =>
        asUser(async () =>
          db.query(
            `insert into public.condition_entries (owner_id, recorded_at, ${column})
             values ($1, now(), ${value})`,
            [userId],
          ),
        ),
      );

    expect(await insertWith("overall_score", "11")).toContain("condition_entries_overall_range");
    expect(await insertWith("mood_score", "-1")).toContain("condition_entries_mood_range");
    expect(await insertWith("body_temperature_c", "29.9")).toContain(
      "condition_entries_temperature_range",
    );
    expect(await insertWith("body_temperature_c", "45.1")).toContain(
      "condition_entries_temperature_range",
    );
  });

  it("自由記述症状は10件まで", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.condition_entries (owner_id, recorded_at, free_text_symptoms)
           values ($1, now(), array['a','b','c','d','e','f','g','h','i','j','k'])`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("condition_entries_free_text_symptoms_valid");
  });

  it("症状リンクを RPC で全置換できる", async () => {
    const entry = await asUser(async () =>
      db.query<{ id: string }>(
        `insert into public.condition_entries (owner_id, recorded_at, overall_score)
         values ($1, timestamptz '2026-09-21T08:00:00Z', 7) returning id`,
        [userId],
      ),
    );
    const entryId = entry.rows[0]?.id ?? "";

    const linked = await asUser(async () =>
      db.query<{ severity: number }>(
        "select * from public.replace_condition_entry_symptoms($1, $2::jsonb)",
        [entryId, JSON.stringify([{ symptomTypeId: headacheTypeId, severity: 3, note: "朝から" }])],
      ),
    );
    expect(linked.rows).toHaveLength(1);
    expect(Number(linked.rows[0]?.severity)).toBe(3);

    const cleared = await asUser(async () =>
      db.query("select * from public.replace_condition_entry_symptoms($1, $2::jsonb)", [
        entryId,
        JSON.stringify([]),
      ]),
    );
    expect(cleared.rows).toHaveLength(0);
  });

  it("同じ体調記録へ同じ症状を二重に紐づけられない", async () => {
    const entry = await asUser(async () =>
      db.query<{ id: string }>(
        `insert into public.condition_entries (owner_id, recorded_at)
         values ($1, timestamptz '2026-09-22T08:00:00Z') returning id`,
        [userId],
      ),
    );
    const entryId = entry.rows[0]?.id ?? "";

    await asUser(async () =>
      db.query(
        `insert into public.condition_entry_symptoms (owner_id, entry_id, symptom_type_id)
         values ($1, $2, $3)`,
        [userId, entryId, headacheTypeId],
      ),
    );

    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.condition_entry_symptoms (owner_id, entry_id, symptom_type_id)
           values ($1, $2, $3)`,
          [userId, entryId, headacheTypeId],
        ),
      ),
    );
    expect(message).toContain("condition_entry_symptoms_entry_type_key");
  });

  it("体調記録を消すと症状リンクも消える（複合外部キーの CASCADE）", async () => {
    const entry = await asUser(async () =>
      db.query<{ id: string }>(
        `insert into public.condition_entries (owner_id, recorded_at)
         values ($1, timestamptz '2026-09-23T08:00:00Z') returning id`,
        [userId],
      ),
    );
    const entryId = entry.rows[0]?.id ?? "";

    await asUser(async () => {
      await db.query(
        `insert into public.condition_entry_symptoms (owner_id, entry_id, symptom_type_id)
         values ($1, $2, $3)`,
        [userId, entryId, headacheTypeId],
      );
      await db.query("delete from public.condition_entries where id = $1", [entryId]);
    });

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from public.condition_entry_symptoms where entry_id = $1",
      [entryId],
    );
    expect(rows[0]?.count).toBe("0");
  });

  /* ------------------------------------------------------------------ */
  /* 目標（実装仕様書 5.5節）                                            */
  /* ------------------------------------------------------------------ */

  it("終了日の無い目標は所有者ごとに1件（睡眠・水分とも）", async () => {
    const goalUser = await signUp(db, "goal-unique@example.test");

    await asAuthenticated(db, goalUser, async () => {
      await db.query(
        `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date)
         values ($1, 420, date '2026-09-01')`,
        [goalUser],
      );
      await db.query(
        `insert into public.hydration_goals (owner_id, target_amount_ml, start_date)
         values ($1, 2000, date '2026-09-01')`,
        [goalUser],
      );
    });

    expect(
      await expectRejection(() =>
        asAuthenticated(db, goalUser, async () =>
          db.query(
            `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date)
             values ($1, 400, date '2026-10-01')`,
            [goalUser],
          ),
        ),
      ),
    ).toContain("sleep_goals_owner_active_key");

    expect(
      await expectRejection(() =>
        asAuthenticated(db, goalUser, async () =>
          db.query(
            `insert into public.hydration_goals (owner_id, target_amount_ml, start_date)
             values ($1, 2500, date '2026-10-01')`,
            [goalUser],
          ),
        ),
      ),
    ).toContain("hydration_goals_owner_active_key");
  });

  it("同じ開始日の目標を2件持てない（409 後の対象特定に使う一意性）", async () => {
    const goalUser = await signUp(db, "goal-start-date@example.test");

    await asAuthenticated(db, goalUser, async () =>
      db.query(
        `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date, end_date)
         values ($1, 420, date '2026-09-01', date '2026-09-30')`,
        [goalUser],
      ),
    );

    const message = await expectRejection(() =>
      asAuthenticated(db, goalUser, async () =>
        db.query(
          `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date, end_date)
           values ($1, 400, date '2026-09-01', date '2026-10-31')`,
          [goalUser],
        ),
      ),
    );
    expect(message).toContain("sleep_goals_owner_start_date_key");
  });

  it("終了日は開始日以降でなければならない", async () => {
    const message = await expectRejection(() =>
      asUser(async () =>
        db.query(
          `insert into public.sleep_goals (owner_id, target_sleep_minutes, start_date, end_date)
           values ($1, 420, date '2026-09-10', date '2026-09-01')`,
          [userId],
        ),
      ),
    );
    expect(message).toContain("sleep_goals_period");
  });

  it("対象曜日は0〜6・重複なし・1件以上", async () => {
    for (const weekdays of ["'{}'", "'{0,0}'", "'{7}'"]) {
      const message = await expectRejection(() =>
        asUser(async () =>
          db.query(
            `insert into public.hydration_goals (owner_id, target_amount_ml, start_date, weekdays)
             values ($1, 2000, date '2026-12-01', ${weekdays}::smallint[])`,
            [userId],
          ),
        ),
      );
      expect(message).toContain("hydration_goals_weekdays_valid");
    }
  });

  /* ------------------------------------------------------------------ */
  /* 冪等キーの適用結果ログ（実装仕様書 5.5節 / 6.4節）                  */
  /* ------------------------------------------------------------------ */

  it("client_mutation_id 付きのミューテーションだけがログへ追記される", async () => {
    const logUser = await signUp(db, "wellness-log@example.test");
    const mutationId = "cccccccc-0000-4000-8000-000000000001";

    await asAuthenticated(db, logUser, async () => {
      // 冪等キー無し → ログに残らない
      await db.query(
        `insert into public.condition_entries (owner_id, recorded_at)
         values ($1, timestamptz '2026-09-24T08:00:00Z')`,
        [logUser],
      );
      // 冪等キーあり → ログに残る
      await db.query(
        `insert into public.condition_entries (owner_id, recorded_at, client_mutation_id)
         values ($1, timestamptz '2026-09-25T08:00:00Z', $2)`,
        [logUser, mutationId],
      );
    });

    const { rows } = await db.query<{
      resource: string;
      operation: string;
      client_mutation_id: string;
    }>(
      "select resource, operation, client_mutation_id from public.wellness_mutation_log where owner_id = $1",
      [logUser],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource).toBe("condition_entries");
    expect(rows[0]?.operation).toBe("insert");
    expect(rows[0]?.client_mutation_id).toBe(mutationId);
  });

  it("ログのスナップショットは適用直後の行（生成列を含む）", async () => {
    const logUser = await signUp(db, "wellness-snapshot@example.test");
    const mutationId = "cccccccc-0000-4000-8000-000000000002";

    await asAuthenticated(db, logUser, async () => {
      await db.query("select public.seed_default_beverage_types()");
      const water = await db.query<{ id: string }>(
        "select id from public.beverage_types where owner_id = $1 and beverage_key = 'water'",
        [logUser],
      );
      await db.query(
        `insert into public.hydration_entries
           (owner_id, beverage_type_id, recorded_at, unit, amount, client_mutation_id)
         values ($1, $2, timestamptz '2026-09-26T09:00:00Z', 'l', 1.5, $3)`,
        [logUser, water.rows[0]?.id, mutationId],
      );
    });

    const { rows } = await db.query<{ snapshot: Record<string, unknown> }>(
      "select snapshot from public.wellness_mutation_log where owner_id = $1 and client_mutation_id = $2",
      [logUser, mutationId],
    );

    const snapshot = rows[0]?.snapshot ?? {};
    expect(Number(snapshot.amount_ml)).toBe(1500);
    expect(Number(snapshot.row_version)).toBe(1);
  });

  it("追記専用ログは authenticated から書き換えられない", async () => {
    const message = await expectRejection(() =>
      asUser(async () => db.query("delete from public.wellness_mutation_log")),
    );
    expect(message).toContain("permission denied");
  });
});

"use client";

/**
 * デモモードのブラウザ内保存（実装仕様書 3.1節）。
 *
 * > Supabaseや外部プロバイダーへ一切送信しない。JSON出力とブラウザ内データ削除を
 * > 画面から実行できる。
 *
 * この構造上の保証がフェーズの主眼なので、このモジュールは Dexie（IndexedDB）
 * だけに依存し、`fetch` も Supabase クライアントも import しない。
 * デモ画面から到達できるコードにネットワーク送信の経路を作らないこと。
 */

import Dexie, { type Table } from "dexie";

import type { DemoProfileRecord } from "./candidate-profile";

/** バージョン付きのDB名。スキーマ変更時は Dexie の `version()` を上げる。 */
export const DEMO_DATABASE_NAME = "health-web-app-demo-v1";

class DemoDatabase extends Dexie {
  profiles!: Table<DemoProfileRecord, string>;

  constructor() {
    super(DEMO_DATABASE_NAME);
    this.version(1).stores({ profiles: "id" });
  }
}

let database: DemoDatabase | null = null;

/** IndexedDB が使えない環境（SSR・プライベートモード等）では `null`。 */
function getDatabase(): DemoDatabase | null {
  if (typeof globalThis.indexedDB === "undefined") {
    return null;
  }

  database ??= new DemoDatabase();
  return database;
}

export async function readDemoProfile(): Promise<DemoProfileRecord | null> {
  const db = getDatabase();
  if (!db) {
    return null;
  }

  return (await db.profiles.get("candidate")) ?? null;
}

/**
 * 確認済みの内容だけを保存する（実装仕様書 5.2節「`confirmed: true` を伴う
 * 確認操作の後にのみ保存する」）。
 */
export async function saveConfirmedDemoProfile(
  profile: DemoProfileRecord["profile"],
): Promise<DemoProfileRecord | null> {
  const db = getDatabase();
  if (!db) {
    return null;
  }

  const record: DemoProfileRecord = {
    id: "candidate",
    profile,
    confirmed: true,
    updatedAt: new Date().toISOString(),
  };

  await db.profiles.put(record);
  return record;
}

/** ブラウザ内のデモデータを削除する（実装仕様書 3.1節）。 */
export async function clearDemoData(): Promise<void> {
  const db = getDatabase();
  if (!db) {
    return;
  }

  await db.profiles.clear();
}

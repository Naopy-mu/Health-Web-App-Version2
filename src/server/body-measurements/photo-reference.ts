import "server-only";

/**
 * 写真参照の所有者検査（実装仕様書 5.3節 / 6.6節 / 9.2節）。
 *
 * 形（HTTPS URL か `storage://health-images/<uuid>/...`）は Zod
 * （`features/body-measurements/schema.ts`）とDBの CHECK 制約が見る。
 * ここが見るのは **`<uuid>` が検証済みセッションの所有者と一致するか**。
 *
 * 実装仕様書 6.6節のオブジェクトパスは `<auth.uid()>/<random-uuid>.<拡張子>` で、
 * 先頭セグメントが所有者にあたる。他人のUIDを書いた参照を保存させると、
 * 署名URL発行の経路が増えたときに他人のオブジェクトを指す入口になる。
 * DB の CHECK 制約も同じ条件（`owner_id::text` との一致）を要求しており、
 * ここはその手前で利用者向けの文言を返すための層。
 */

import { parseStoragePhotoReference } from "@/features/body-measurements/schema";

import { invalidRequest } from "../api/errors";
import type { GuardResult } from "../api/guards";

/**
 * `storage://` 形式なら所有者一致を要求する。HTTPS URL と `null` はそのまま通す。
 * UUID は大文字小文字を区別せずに比較する（DB は正規化済みの小文字を保持する）。
 */
export function ensureOwnedPhotoReference(
  reference: string | null | undefined,
  ownerId: string,
): GuardResult<null> {
  if (reference === null || reference === undefined) {
    return { ok: true, value: null };
  }

  const storageReference = parseStoragePhotoReference(reference);
  if (storageReference === null) {
    // HTTPS URL（形は Zod が検証済み）。
    return { ok: true, value: null };
  }

  if (storageReference.ownerId.toLowerCase() !== ownerId.toLowerCase()) {
    return {
      ok: false,
      // 実装仕様書 9.2節: 文言に受け取った値そのものを含めない。
      response: invalidRequest("写真参照には自分のストレージパスのみ指定できます。"),
    };
  }

  return { ok: true, value: null };
}

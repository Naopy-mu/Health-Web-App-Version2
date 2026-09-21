import "server-only";

/**
 * サプリメントの一覧ページング（実装仕様書 7章）。
 *
 * オフセット方式は、ページ送りの最中に新しい記録が入ると行の取りこぼし・
 * 重複が起きる。服用記録も在庫の動きも時系列に追記され続けるため、
 * **`(時間軸, id)` のキーセット（カーソル）方式**を使う。
 * Phase 3a / 4-1a の `cursor.ts` と同じ設計で、時間軸の列名だけ
 * リソースごとに差し替える。
 *
 * カーソルは不透明な文字列としてクライアントへ渡す。中身に所有者IDや
 * 健康データは入れない（実装仕様書 9.2節）。
 */

export type SupplementCursor = {
  /** ISO 8601（`Z` 付き）。 */
  readonly timestamp: string;
  readonly id: string;
};

const CURSOR_SEPARATOR = "|";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** カーソルを base64url の不透明文字列にする。 */
export function encodeSupplementCursor(cursor: SupplementCursor): string {
  return Buffer.from(`${cursor.timestamp}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * カーソルを復号する。壊れた値・改竄された値は `null`。
 * 呼び出し側は `null` を 400（`INVALID_REQUEST`）として扱う。
 */
export function decodeSupplementCursor(raw: string): SupplementCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const [timestamp, id, ...rest] = decoded.split(CURSOR_SEPARATOR);
  if (timestamp === undefined || id === undefined || rest.length > 0) {
    return null;
  }

  if (!UUID_PATTERN.test(id)) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return { timestamp: parsed.toISOString(), id };
}

/**
 * PostgREST の `.or()` へ渡すキーセット条件。
 *
 * - `desc`: `<column> < :at` または（`<column> = :at` かつ `id < :id`）
 * - `asc` : `<column> > :at` または（`<column> = :at` かつ `id > :id`）
 */
export function keysetFilter(
  cursor: SupplementCursor,
  column: string,
  order: "asc" | "desc",
): string {
  const comparison = order === "desc" ? "lt" : "gt";
  return [
    `${column}.${comparison}.${cursor.timestamp}`,
    `and(${column}.eq.${cursor.timestamp},id.${comparison}.${cursor.id})`,
  ].join(",");
}

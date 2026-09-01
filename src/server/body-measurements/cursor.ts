import "server-only";

/**
 * 測定記録一覧のページング（実装仕様書 7章 / 5.1節の出力上限の考え方）。
 *
 * オフセット方式は、ページ送りの最中に新しい記録が入ると行の取りこぼし・
 * 重複が起きる。測定記録は時系列に追記され続けるため、
 * **`(measured_at, id)` のキーセット（カーソル）方式**を使う。
 *
 * `measured_at` だけでは一意にならない（別種別の同時刻の記録がありうる）ため、
 * `id` を同順位の決定子に加える。並び順は `order` に従い、比較の向きも合わせる。
 *
 * カーソルは不透明な文字列としてクライアントへ渡す。中身に所有者IDや
 * 健康データは入れない（実装仕様書 9.2節）。
 */

export type MeasurementCursor = {
  /** ISO 8601（`Z` 付き）。 */
  readonly measuredAt: string;
  readonly id: string;
};

const CURSOR_SEPARATOR = "|";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** カーソルを base64url の不透明文字列にする。 */
export function encodeMeasurementCursor(cursor: MeasurementCursor): string {
  return Buffer.from(`${cursor.measuredAt}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * カーソルを復号する。壊れた値・改竄された値は `null`。
 * 呼び出し側は `null` を 400（`INVALID_REQUEST`）として扱う。
 */
export function decodeMeasurementCursor(raw: string): MeasurementCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const [measuredAt, id, ...rest] = decoded.split(CURSOR_SEPARATOR);
  if (measuredAt === undefined || id === undefined || rest.length > 0) {
    return null;
  }

  if (!UUID_PATTERN.test(id)) {
    return null;
  }

  const parsed = new Date(measuredAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return { measuredAt: parsed.toISOString(), id };
}

/**
 * PostgREST の `.or()` へ渡すキーセット条件。
 *
 * - `desc`: `measured_at < :at` または（`measured_at = :at` かつ `id < :id`）
 * - `asc` : `measured_at > :at` または（`measured_at = :at` かつ `id > :id`）
 */
export function keysetFilter(cursor: MeasurementCursor, order: "asc" | "desc"): string {
  const comparison = order === "desc" ? "lt" : "gt";
  return [
    `measured_at.${comparison}.${cursor.measuredAt}`,
    `and(measured_at.eq.${cursor.measuredAt},id.${comparison}.${cursor.id})`,
  ].join(",");
}

import "server-only";

/**
 * アカウントデータ出力の直列化（実装仕様書 5.1節「データ出力・削除」/ 9.2節）。
 *
 * Phase 2 では identity（`users` / `user_profiles`）のみを対象にした骨格を置く。
 *
 * TODO(Phase 3以降): 実装仕様書 5.1節の全所有者範囲テーブル（身体測定・運動・
 * 睡眠/水分/体調・サプリメント・食事・在庫・カレンダー・習慣・レポート等）を
 * 各機能テーブルの追加に合わせて `ACCOUNT_EXPORT_TABLES` へ加える。併せて
 * 1テーブル25,000行／合計100,000行／ページサイズ500行の上限とページングを実装する。
 */

/** 実装仕様書 5.1節の出力上限。ページングを実装する後続フェーズで使用する。 */
export const EXPORT_MAX_ROWS_PER_TABLE = 25_000;
export const EXPORT_MAX_ROWS_TOTAL = 100_000;
export const EXPORT_PAGE_SIZE = 500;

/**
 * 出力対象テーブル。所有者スコープのRLS適用済みクライアントで読むため、
 * ここに他利用者の行が混ざることはない（実装仕様書 6.5節）。
 */
export const ACCOUNT_EXPORT_TABLES = ["users", "user_profiles"] as const;

export type AccountExportTable = (typeof ACCOUNT_EXPORT_TABLES)[number];

export type AccountExportPayload = {
  readonly exportedAt: string;
  readonly schemaVersion: 1;
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
};

/**
 * CSVの数式インジェクション対策（実装仕様書 9.2節）。
 *
 * > CSVは数式インジェクション対策（`=+-@` 前置クォート）を全経路で適用する。
 *
 * 表計算ソフトが数式として解釈しうる先頭文字を持つ値に `'` を前置する。
 * タブ・復帰で始まる値も、除去後に数式化されうるため同様に扱う。
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  const formulaLeading = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;

  // RFC 4180: 二重引用符で囲み、内部の `"` を二重化する。
  return `"${formulaLeading.replaceAll('"', '""')}"`;
}

/** 1テーブル分のCSV（ヘッダー行つき）。行が無い場合は空文字を返す。 */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return "";
  }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const header = columns.map(escapeCsvValue).join(",");
  const body = rows.map((row) => columns.map((column) => escapeCsvValue(row[column])).join(","));

  return [header, ...body].join("\r\n");
}

/**
 * 複数テーブルを1つのCSVへまとめる。テーブルごとに `# <table>` の見出しを挟む。
 * 見出しにも `escapeCsvValue` を通し、テーブル名経由の注入経路を残さない。
 */
export function toMultiTableCsv(
  tables: Record<string, readonly Record<string, unknown>[]>,
): string {
  const sections: string[] = [];

  for (const [table, rows] of Object.entries(tables)) {
    sections.push(escapeCsvValue(`# ${table}`));
    const csv = toCsv(rows);
    sections.push(csv === "" ? escapeCsvValue("(no rows)") : csv);
    sections.push("");
  }

  return sections.join("\r\n");
}

/** `Content-Disposition: attachment` のファイル名（実装仕様書 5.1節）。 */
export function exportFileName(format: "json" | "csv", now: Date): string {
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return `health-web-app-export-${stamp}.${format}`;
}

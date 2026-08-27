// @vitest-environment node
import { describe, expect, it } from "vitest";

import { escapeCsvValue, exportFileName, toCsv, toMultiTableCsv } from "./export";

/**
 * 実装仕様書 9.2節:
 * > CSVは数式インジェクション対策（`=+-@` 前置クォート）を全経路で適用する。
 */
describe("escapeCsvValue（実装仕様書 9.2節 数式インジェクション対策）", () => {
  it("数式として解釈されうる先頭文字へ `'` を前置する", () => {
    expect(escapeCsvValue("=1+1")).toBe(`"'=1+1"`);
    expect(escapeCsvValue("+1")).toBe(`"'+1"`);
    expect(escapeCsvValue("-1")).toBe(`"'-1"`);
    expect(escapeCsvValue("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(escapeCsvValue('=HYPERLINK("http://evil.example")')).toBe(
      `"'=HYPERLINK(""http://evil.example"")"`,
    );
  });

  it("除去後に数式化されうるタブ・復帰始まりも前置する", () => {
    expect(escapeCsvValue("\t=1+1")).toBe(`"'\t=1+1"`);
    expect(escapeCsvValue("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("通常の値には前置しない", () => {
    expect(escapeCsvValue("体重")).toBe(`"体重"`);
    expect(escapeCsvValue(64.2)).toBe(`"64.2"`);
    expect(escapeCsvValue(0)).toBe(`"0"`);
    expect(escapeCsvValue(false)).toBe(`"false"`);
  });

  it("引用符を二重化し、区切り・改行を含む値を壊さない", () => {
    expect(escapeCsvValue('say "hi"')).toBe(`"say ""hi"""`);
    expect(escapeCsvValue("a,b")).toBe(`"a,b"`);
    expect(escapeCsvValue("a\nb")).toBe(`"a\nb"`);
  });

  it("null / undefined は空欄にする", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });

  it("オブジェクトはJSONにしたうえでエスケープする", () => {
    expect(escapeCsvValue({ confirmed: true })).toBe(`"{""confirmed"":true}"`);
  });
});

describe("toCsv", () => {
  it("全行の列を集めたヘッダー行を先頭に置く", () => {
    const csv = toCsv([
      { id: "a", status: "active" },
      { id: "b", timezone: "Asia/Tokyo" },
    ]);

    expect(csv.split("\r\n")).toStrictEqual([
      `"id","status","timezone"`,
      `"a","active",`,
      `"b",,"Asia/Tokyo"`,
    ]);
  });

  it("行が無ければ空文字を返す", () => {
    expect(toCsv([])).toBe("");
  });

  it("列名も数式インジェクション対策を通す", () => {
    expect(toCsv([{ "=cmd": 1 }]).split("\r\n")[0]).toBe(`"'=cmd"`);
  });
});

describe("toMultiTableCsv", () => {
  it("テーブルごとに見出しを挟む", () => {
    const csv = toMultiTableCsv({
      users: [{ id: "a" }],
      user_profiles: [],
    });

    expect(csv).toContain(`"# users"`);
    expect(csv).toContain(`"# user_profiles"`);
    expect(csv).toContain(`"(no rows)"`);
  });
});

describe("exportFileName（実装仕様書 5.1節）", () => {
  it("形式に応じた拡張子と、ファイル名に使える時刻を組み立てる", () => {
    const name = exportFileName("json", new Date("2026-08-27T12:34:56.789Z"));
    expect(name).toBe("health-web-app-export-2026-08-27T12-34-56-789Z.json");
    expect(name).not.toContain(":");
    expect(exportFileName("csv", new Date("2026-08-27T00:00:00.000Z")).endsWith(".csv")).toBe(true);
  });
});

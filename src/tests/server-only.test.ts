import "server-only";

import { describe, expect, it } from "vitest";

/**
 * 実装仕様書 2.1節: サーバー専用モジュールは `import "server-only";` を宣言する。
 * 本番ビルドではクライアントからの参照がビルドエラーになり、Vitest では
 * `vitest.config.ts` の alias が `src/tests/server-only.ts` へ解決する。
 * この境界が壊れると、素の `server-only` が読み込まれて import 時に例外になる。
 */
describe("server-only boundary", () => {
  it("resolves the Vitest stand-in instead of throwing", () => {
    expect(true).toBe(true);
  });
});

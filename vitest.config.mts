import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const resolvePath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolvePath("./src"),
      // 実装仕様書 2.1節: サーバー専用モジュールは `import "server-only";` を宣言する。
      // Vitest では Next.js のバンドラーを通らないため、テスト用スタブへ差し替える。
      "server-only": resolvePath("./src/tests/server-only.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**", "staging-e2e/**"],
    globals: false,
  },
});

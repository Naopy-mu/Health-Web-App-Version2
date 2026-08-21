#!/usr/bin/env node
/**
 * `npm run env:check` の雛形（実装仕様書 13.1節）。
 *
 * Phase 0 では引数の受け取りと終了コードの枠だけを用意する。実際の検証
 * （欠落・不正の検出、本番での `fake` / プレースホルダー拒否）は後続フェーズで
 * 実装する。値そのものは絶対に出力せず、欠落・不正の事実のみを報告すること。
 */

const args = process.argv.slice(2);
const environmentIndex = args.indexOf("--environment");
const environment = environmentIndex === -1 ? "local" : (args[environmentIndex + 1] ?? "local");
const knownEnvironments = new Set(["local", "staging", "production"]);

if (!knownEnvironments.has(environment)) {
  console.error(`env:check: unknown environment "${environment}"`);
  process.exit(1);
}

console.log(`env:check: environment=${environment}`);
console.log("env:check: not implemented yet (Phase 0 scaffold); no variables were validated.");
process.exit(0);

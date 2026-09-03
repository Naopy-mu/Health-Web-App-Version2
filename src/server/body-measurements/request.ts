import "server-only";

/**
 * 身体測定APIの入力検証（実装仕様書 9.2節）。
 *
 * 実体は機能に依らない共通層 `src/server/api/validation.ts` にある
 * （Phase 4-1a で睡眠・水分・体調が同じ手順を必要としたため移した）。
 * Phase 3a の呼び出し元がそのまま動くよう、ここから再エクスポートする。
 */

export { parseQueryParams, parseRequestBody } from "../api/validation";

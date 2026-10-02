/**
 * サプリメント画面用の状態管理・API 呼び出し Hook。
 *
 * 楽観ロック競合（409）が発生した場合は、`docs/api/supplements.md` 1.8節に従い
 * 行の主キー（`id`）で対象を直接取得し、編集中の行の `rowVersion` だけを
 * 最新化して入力内容を保持する。
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DeleteSupplementRequest,
  SaveSupplementRequest,
  SupplementIntake,
  SupplementListQuery,
  SupplementListResource,
  SupplementListResponse,
  SupplementLot,
  SupplementProduct,
  SupplementSchedule,
} from "./schema";
import { deleteSupplement, listSupplements, saveSupplement } from "./api";
import type { ApiError } from "./api";
import {
  buildSupplementRefetchQuery,
  interpretSupplementRefetch,
  type SupplementConflictTarget,
} from "./conflict";
import { normalizeSupplementName } from "./units";

export type SupplementEntry = SupplementSchedule | SupplementLot | SupplementIntake;

export type ConflictInfo = {
  /** サプリメント API のエラーコード。 */
  code: string;
  /** サーバーから返されたメッセージ。 */
  message: string;
  /** 競合対象の最新値（あれば）。 */
  target?:
    | { kind: "product"; data: SupplementProduct }
    | { kind: "schedule"; data: SupplementSchedule }
    | { kind: "lot"; data: SupplementLot }
    | { kind: "intake"; data: SupplementIntake };
};

type LoadingState = "idle" | "loading" | "submitting";

function isConflictError(error: ApiError | undefined): boolean {
  return error?.code === "SUPPLEMENT_CONFLICT" || error?.code === "SUPPLEMENT_DUPLICATE_CONFLICT";
}

function refreshRowVersion<T extends { id: string; rowVersion: number; updatedAt: string }>(
  current: T | null,
  latest: T | undefined,
): T | null {
  if (!current || !latest || current.id !== latest.id) {
    return current;
  }
  return { ...current, rowVersion: latest.rowVersion, updatedAt: latest.updatedAt };
}

export function useSupplements<T extends SupplementEntry>(resource: SupplementListResource) {
  const [entries, setEntries] = useState<T[]>([]);
  const [products, setProducts] = useState<SupplementProduct[]>([]);
  const [summary, setSummary] = useState<SupplementListResponse["data"]["summary"] | undefined>();
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const activeProducts = useMemo(
    () => products.filter((product) => product.archivedAt === null),
    [products],
  );

  const archivedProducts = useMemo(
    () => products.filter((product) => product.archivedAt !== null),
    [products],
  );

  const listQuery: SupplementListQuery = useMemo(
    () => ({
      resource,
      order: "desc",
      limit: 100,
    }),
    [resource],
  );

  const load = useCallback(async () => {
    setLoadingState((prev) => (prev === "submitting" ? "submitting" : "loading"));
    setError(null);
    setConflict(null);

    const result = await listSupplements(listQuery);
    if (!result.ok) {
      setLoadingState("idle");
      if (result.status === 401) {
        window.location.href = `/auth?next=/supplements`;
        return;
      }
      setError(result.error.message);
      return;
    }

    setEntries(result.data.entries as T[]);
    setNextCursor(result.data.page.nextCursor);
    setProducts(result.data.products);
    setSummary(result.data.summary);

    setLoadingState("idle");
  }, [listQuery]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMore = useCallback(async () => {
    if (!nextCursor) {
      return false;
    }
    setIsLoadingMore(true);
    const result = await listSupplements({ ...listQuery, cursor: nextCursor });
    setIsLoadingMore(false);
    if (!result.ok) {
      if (result.status === 401) {
        window.location.href = `/auth?next=/supplements`;
        return false;
      }
      setError(result.error.message);
      return false;
    }
    setEntries((prev) => [...prev, ...(result.data.entries as T[])]);
    setNextCursor(result.data.page.nextCursor);
    return true;
  }, [listQuery, nextCursor]);

  const handleRefetchAfterConflict = useCallback(async (target: SupplementConflictTarget) => {
    const { strategy, params } = buildSupplementRefetchQuery(target);
    const refetchResult = await listSupplements({
      resource: target.resource,
      id: params.get("id") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      limit: Number(params.get("limit") ?? "1"),
      order: "desc",
    });

    if (!refetchResult.ok) {
      setError(refetchResult.error.message);
      return undefined;
    }

    const outcome = interpretSupplementRefetch(
      strategy,
      refetchResult.data.entries as SupplementEntry[],
      target,
    );
    if (outcome.kind === "deleted") {
      return { kind: "deleted" as const };
    }
    if (outcome.kind === "found") {
      return { kind: "found" as const, entry: outcome.entry };
    }
    return undefined;
  }, []);

  const handleMutationError = useCallback(
    async (
      apiError: ApiError,
      status: number,
      options:
        | {
            kind: "product";
            targetProductKey?: string;
            targetName?: string;
            editingProduct: SupplementProduct | null;
            setEditingProduct?: (product: SupplementProduct | null) => void;
          }
        | {
            kind: "schedule";
            target: SupplementConflictTarget;
            editingSchedule: SupplementSchedule | null;
            setEditingSchedule?: (schedule: SupplementSchedule | null) => void;
          }
        | {
            kind: "lot";
            target: SupplementConflictTarget;
            editingLot: SupplementLot | null;
            setEditingLot?: (lot: SupplementLot | null) => void;
          }
        | {
            kind: "intake";
            target: SupplementConflictTarget;
            editingIntake: SupplementIntake | null;
            setEditingIntake?: (intake: SupplementIntake | null) => void;
          },
    ) => {
      if (status === 401) {
        window.location.href = `/auth?next=/supplements`;
        return;
      }
      if (!isConflictError(apiError)) {
        setError(apiError.message);
        return;
      }

      const listResult = await listSupplements(listQuery);
      if (!listResult.ok) {
        setError(listResult.error.message);
        setLoadingState("idle");
        return;
      }

      setEntries(listResult.data.entries as T[]);
      setNextCursor(listResult.data.page.nextCursor);
      setProducts(listResult.data.products);
      setSummary(listResult.data.summary);

      let target: ConflictInfo["target"] = undefined;

      if (options.kind === "product") {
        let latest: SupplementProduct | undefined;
        if (options.editingProduct) {
          latest = listResult.data.products.find((p) => p.id === options.editingProduct?.id);
        }
        if (!latest && options.targetProductKey) {
          latest = listResult.data.products.find((p) => p.productKey === options.targetProductKey);
        }
        if (!latest && options.targetName) {
          const normalized = normalizeSupplementName(options.targetName);
          latest = listResult.data.products.find((p) => p.nameNormalized === normalized);
        }
        if (latest) {
          target = { kind: "product", data: latest };
          const updated = refreshRowVersion(options.editingProduct, latest);
          options.setEditingProduct?.(updated);
        } else {
          options.setEditingProduct?.(null);
        }
      } else if (options.kind === "schedule") {
        const refetchOutcome = await handleRefetchAfterConflict(options.target);
        if (refetchOutcome?.kind === "found") {
          const entry = refetchOutcome.entry as SupplementSchedule;
          target = { kind: "schedule", data: entry };
          const updated = refreshRowVersion(options.editingSchedule, entry);
          options.setEditingSchedule?.(updated);
        } else if (refetchOutcome?.kind === "deleted") {
          options.setEditingSchedule?.(null);
        }
      } else if (options.kind === "lot") {
        const refetchOutcome = await handleRefetchAfterConflict(options.target);
        if (refetchOutcome?.kind === "found") {
          const entry = refetchOutcome.entry as SupplementLot;
          target = { kind: "lot", data: entry };
          const updated = refreshRowVersion(options.editingLot, entry);
          options.setEditingLot?.(updated);
        } else if (refetchOutcome?.kind === "deleted") {
          options.setEditingLot?.(null);
        }
      } else if (options.kind === "intake") {
        const refetchOutcome = await handleRefetchAfterConflict(options.target);
        if (refetchOutcome?.kind === "found") {
          const entry = refetchOutcome.entry as SupplementIntake;
          target = { kind: "intake", data: entry };
          const updated = refreshRowVersion(options.editingIntake, entry);
          options.setEditingIntake?.(updated);
        } else if (refetchOutcome?.kind === "deleted") {
          options.setEditingIntake?.(null);
        }
      }

      setConflict({
        code: apiError.code,
        message: apiError.message,
        target,
      });
    },
    [handleRefetchAfterConflict, listQuery],
  );

  const saveProduct = useCallback(
    async (
      request: Extract<SaveSupplementRequest, { resource: "product" }>,
      options: {
        editingProduct: SupplementProduct | null;
        setEditingProduct?: (product: SupplementProduct | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        await handleMutationError(result.error, result.status, {
          kind: "product",
          targetProductKey: request.product.productKey,
          targetName: request.product.name,
          editingProduct: options.editingProduct,
          setEditingProduct: options.setEditingProduct,
        });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const saveSchedule = useCallback(
    async (
      request: Extract<SaveSupplementRequest, { resource: "schedule" }>,
      options: {
        editingSchedule: SupplementSchedule | null;
        setEditingSchedule?: (schedule: SupplementSchedule | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        const original = options.editingSchedule;
        const target: SupplementConflictTarget = {
          resource: "schedule",
          id: original?.id ?? request.schedule.id,
          productId: original?.productId ?? request.schedule.productId,
          scheduleKind: original?.scheduleKind ?? request.schedule.scheduleKind,
          startDate: original?.startDate ?? request.schedule.startDate,
        };
        await handleMutationError(result.error, result.status, {
          kind: "schedule",
          target,
          editingSchedule: options.editingSchedule,
          setEditingSchedule: options.setEditingSchedule,
        });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const saveLot = useCallback(
    async (
      request: Extract<SaveSupplementRequest, { resource: "lot" }>,
      options: {
        editingLot: SupplementLot | null;
        setEditingLot?: (lot: SupplementLot | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        const original = options.editingLot;
        const target: SupplementConflictTarget = {
          resource: "lot",
          id: original?.id ?? request.lot.id,
          productId: original?.productId ?? request.lot.productId,
          lotCode: original?.lotCode ?? request.lot.lotCode ?? null,
        };
        await handleMutationError(result.error, result.status, {
          kind: "lot",
          target,
          editingLot: options.editingLot,
          setEditingLot: options.setEditingLot,
        });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const recordIntake = useCallback(
    async (request: Extract<SaveSupplementRequest, { resource: "intake" }>): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        setError(result.error.message);
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [load],
  );

  const voidIntake = useCallback(
    async (
      request: Extract<SaveSupplementRequest, { resource: "void_intake" }>,
      options: {
        editingIntake: SupplementIntake | null;
        setEditingIntake?: (intake: SupplementIntake | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        const target: SupplementConflictTarget = {
          resource: "intake",
          id: options.editingIntake?.id ?? request.void.id,
        };
        await handleMutationError(result.error, result.status, {
          kind: "intake",
          target,
          editingIntake: options.editingIntake,
          setEditingIntake: options.setEditingIntake,
        });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const removeSchedule = useCallback(
    async (
      request: DeleteSupplementRequest,
      options: {
        editingSchedule: SupplementSchedule | null;
        setEditingSchedule?: (schedule: SupplementSchedule | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await deleteSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        const original = options.editingSchedule;
        const target: SupplementConflictTarget = {
          resource: "schedule",
          id: original?.id ?? request.id,
          productId: original?.productId ?? "",
          scheduleKind: original?.scheduleKind ?? "daily",
          startDate: original?.startDate ?? new Date().toISOString().slice(0, 10),
        };
        await handleMutationError(result.error, result.status, {
          kind: "schedule",
          target,
          editingSchedule: options.editingSchedule,
          setEditingSchedule: options.setEditingSchedule,
        });
        setLoadingState("idle");
        return false;
      }

      if (options.editingSchedule?.id === request.id) {
        options.setEditingSchedule?.(null);
      }
      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const removeLot = useCallback(
    async (
      request: DeleteSupplementRequest,
      options: {
        editingLot: SupplementLot | null;
        setEditingLot?: (lot: SupplementLot | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await deleteSupplement(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/supplements`;
          return false;
        }
        const original = options.editingLot;
        const target: SupplementConflictTarget = {
          resource: "lot",
          id: original?.id ?? request.id,
          productId: original?.productId ?? "",
          lotCode: original?.lotCode ?? null,
        };
        await handleMutationError(result.error, result.status, {
          kind: "lot",
          target,
          editingLot: options.editingLot,
          setEditingLot: options.setEditingLot,
        });
        setLoadingState("idle");
        return false;
      }

      if (options.editingLot?.id === request.id) {
        options.setEditingLot?.(null);
      }
      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  return {
    entries,
    products,
    activeProducts,
    archivedProducts,
    summary,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    load,
    loadMore,
    saveProduct,
    saveSchedule,
    saveLot,
    recordIntake,
    voidIntake,
    removeSchedule,
    removeLot,
  };
}

/**
 * 睡眠・水分・体調画面用の状態管理・API 呼び出し Hook。
 *
 * 楽観ロック競合（409）が発生した場合は、`docs/api/wellness.md` 1.7節に従い
 * 行の主キー（`id`）で対象を直接取得し、編集中の行の `rowVersion` だけを
 * 最新化して入力内容を保持する。
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  BeverageType,
  ConditionEntry,
  DeleteWellnessRequest,
  HydrationEntry,
  HydrationGoal,
  SaveWellnessRequest,
  SleepEntry,
  SleepGoal,
  SymptomType,
  WellnessContext,
  WellnessListQuery,
  WellnessListResource,
} from "./schema";
import { deleteWellness, listWellness, saveWellness } from "./api";
import {
  buildWellnessRefetchQuery,
  interpretWellnessRefetch,
  type WellnessConflictTarget,
} from "./conflict";
import type { ApiError } from "./api";
import { generateUuid } from "./utils";

export type WellnessEntry = SleepEntry | HydrationEntry | ConditionEntry;
export type WellnessGoal = SleepGoal | HydrationGoal;

export type ConflictInfo = {
  /** wellness API のエラーコード。 */
  code: string;
  /** サーバーから返されたメッセージ。 */
  message: string;
  /** 競合対象の最新値（あれば）。 */
  target?:
    | { kind: "entry"; data: WellnessEntry }
    | { kind: "goal"; data: WellnessGoal }
    | { kind: "type"; data: BeverageType | SymptomType };
};

type LoadingState = "idle" | "loading" | "submitting";

const EMPTY_CONTEXT: WellnessContext = {
  activeSleepGoal: null,
  activeHydrationGoal: null,
};

function isConflictError(error: ApiError | undefined): boolean {
  return (
    error?.code === "WELLNESS_CONFLICT" ||
    error?.code === "WELLNESS_DUPLICATE_CONFLICT" ||
    error?.code === "WELLNESS_GOAL_CONFLICT" ||
    error?.code === "WELLNESS_TYPE_CONFLICT"
  );
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

export function useWellness<T extends WellnessEntry>(resource: WellnessListResource) {
  const [entries, setEntries] = useState<T[]>([]);
  const [beverageTypes, setBeverageTypes] = useState<BeverageType[]>([]);
  const [symptomTypes, setSymptomTypes] = useState<SymptomType[]>([]);
  const [sleepGoals, setSleepGoals] = useState<SleepGoal[]>([]);
  const [hydrationGoals, setHydrationGoals] = useState<HydrationGoal[]>([]);
  const [context, setContext] = useState<WellnessContext>(EMPTY_CONTEXT);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const activeBeverageTypes = useMemo(
    () =>
      beverageTypes
        .filter((type) => type.archivedAt === null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.beverageKey.localeCompare(b.beverageKey)),
    [beverageTypes],
  );

  const activeSymptomTypes = useMemo(
    () =>
      symptomTypes
        .filter((type) => type.archivedAt === null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.symptomKey.localeCompare(b.symptomKey)),
    [symptomTypes],
  );

  const archivedBeverageTypes = useMemo(
    () =>
      beverageTypes
        .filter((type) => type.archivedAt !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.beverageKey.localeCompare(b.beverageKey)),
    [beverageTypes],
  );

  const archivedSymptomTypes = useMemo(
    () =>
      symptomTypes
        .filter((type) => type.archivedAt !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.symptomKey.localeCompare(b.symptomKey)),
    [symptomTypes],
  );

  const listQuery: WellnessListQuery = useMemo(
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

    const result = await listWellness(listQuery);
    if (!result.ok) {
      setLoadingState("idle");
      if (result.status === 401) {
        window.location.href = `/auth?next=/${resource}`;
        return;
      }
      setError(result.error.message);
      return;
    }

    setEntries(result.data.entries as T[]);
    setNextCursor(result.data.page.nextCursor);
    setBeverageTypes(result.data.beverageTypes);
    setSymptomTypes(result.data.symptomTypes);
    setSleepGoals(result.data.sleepGoals);
    setHydrationGoals(result.data.hydrationGoals);
    setContext(result.data.context);

    // 既定種別が未投入なら seed する
    if (result.data.beverageTypes.length === 0 && result.data.symptomTypes.length === 0) {
      const seedResult = await saveWellness({ resource: "seed_defaults" });
      if (seedResult.ok) {
        const reload = await listWellness(listQuery);
        if (reload.ok) {
          setEntries(reload.data.entries as T[]);
          setNextCursor(reload.data.page.nextCursor);
          setBeverageTypes(reload.data.beverageTypes);
          setSymptomTypes(reload.data.symptomTypes);
          setSleepGoals(reload.data.sleepGoals);
          setHydrationGoals(reload.data.hydrationGoals);
          setContext(reload.data.context);
        }
      } else if (seedResult.status !== 401) {
        setError(seedResult.error.message);
      }
    }

    setLoadingState("idle");
  }, [listQuery, resource]);

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
    const result = await listWellness({ ...listQuery, cursor: nextCursor });
    setIsLoadingMore(false);
    if (!result.ok) {
      if (result.status === 401) {
        window.location.href = `/auth?next=/${resource}`;
        return false;
      }
      setError(result.error.message);
      return false;
    }
    setEntries((prev) => [...prev, ...(result.data.entries as T[])]);
    setNextCursor(result.data.page.nextCursor);
    return true;
  }, [listQuery, nextCursor, resource]);

  const handleRefetchAfterConflict = useCallback(async (target: WellnessConflictTarget) => {
    const { strategy, params } = buildWellnessRefetchQuery(target);
    const refetchResult = await listWellness({
      resource: target.resource,
      id: params.get("id") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      sleepKind: (params.get("sleepKind") as WellnessListQuery["sleepKind"]) ?? undefined,
      beverageTypeId: params.get("beverageTypeId") ?? undefined,
      limit: Number(params.get("limit") ?? "1"),
      order: "desc",
    });

    if (!refetchResult.ok) {
      setError(refetchResult.error.message);
      return undefined;
    }

    const outcome = interpretWellnessRefetch(
      strategy,
      refetchResult.data.entries as WellnessEntry[],
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
      options: {
        target: WellnessConflictTarget;
        editingEntry: T | null;
        setEditingEntry?: (entry: T | null) => void;
      },
    ) => {
      if (status === 401) {
        window.location.href = `/auth?next=/${resource}`;
        return;
      }
      if (!isConflictError(apiError)) {
        setError(apiError.message);
        return;
      }

      // 一覧を再取得し、最新状態を反映する
      const listResult = await listWellness(listQuery);
      if (!listResult.ok) {
        setError(listResult.error.message);
        setLoadingState("idle");
        return;
      }

      setEntries(listResult.data.entries as T[]);
      setNextCursor(listResult.data.page.nextCursor);
      setBeverageTypes(listResult.data.beverageTypes);
      setSymptomTypes(listResult.data.symptomTypes);
      setSleepGoals(listResult.data.sleepGoals);
      setHydrationGoals(listResult.data.hydrationGoals);
      setContext(listResult.data.context);

      // 対象特定クエリで最新の rowVersion を取得する
      const refetchOutcome = await handleRefetchAfterConflict(options.target);

      let target: ConflictInfo["target"] = undefined;

      if (refetchOutcome?.kind === "found") {
        target = { kind: "entry", data: refetchOutcome.entry };
        const current = options.editingEntry;
        if (current && current.id === refetchOutcome.entry.id) {
          const updated = refreshRowVersion(current, refetchOutcome.entry as T);
          options.setEditingEntry?.(updated);
        }
      } else if (refetchOutcome?.kind === "deleted") {
        // 削除済みなら編集を破棄する
        options.setEditingEntry?.(null);
      }

      setConflict({
        code: apiError.code,
        message: apiError.message,
        target,
      });
    },
    [handleRefetchAfterConflict, listQuery, resource],
  );

  const saveEntry = useCallback(
    async (
      request: SaveWellnessRequest,
      options: {
        editingEntry: T | null;
        setEditingEntry?: (entry: T | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveWellness(request);
      if (!result.ok) {
        // 409 後の対象特定に使う target を組み立てる
        let target: WellnessConflictTarget | undefined;
        if (request.resource === "sleep") {
          const original = options.editingEntry as SleepEntry | null;
          target = {
            resource: "sleep",
            id: original?.id ?? request.entry.id,
            sleepKind: original?.sleepKind ?? request.entry.sleepKind,
            sleepAt: original?.sleepAt ?? request.entry.sleepAt,
          };
        } else if (request.resource === "hydration") {
          const original = options.editingEntry as HydrationEntry | null;
          target = {
            resource: "hydration",
            id: original?.id ?? request.entry.id,
            beverageTypeId: original?.beverageTypeId ?? request.entry.beverageTypeId,
            recordedAt: original?.recordedAt ?? request.entry.recordedAt,
          };
        } else if (request.resource === "condition") {
          const original = options.editingEntry as ConditionEntry | null;
          target = {
            resource: "condition",
            id: original?.id ?? request.entry.id,
            recordedAt: original?.recordedAt ?? request.entry.recordedAt,
          };
        }

        if (target) {
          await handleMutationError(result.error, result.status, {
            target,
            editingEntry: options.editingEntry,
            setEditingEntry: options.setEditingEntry,
          });
        } else {
          setError(result.error.message);
        }
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const removeEntry = useCallback(
    async (
      request: DeleteWellnessRequest,
      options: {
        editingEntry: T | null;
        setEditingEntry?: (entry: T | null) => void;
      },
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await deleteWellness(request);
      if (!result.ok) {
        let target: WellnessConflictTarget | undefined;
        if (request.resource === "sleep") {
          const original = options.editingEntry as SleepEntry | null;
          target = {
            resource: "sleep",
            id: original?.id ?? request.id,
            sleepKind: original?.sleepKind ?? "night",
            sleepAt: original?.sleepAt ?? new Date().toISOString(),
          };
        } else if (request.resource === "hydration") {
          const original = options.editingEntry as HydrationEntry | null;
          target = {
            resource: "hydration",
            id: original?.id ?? request.id,
            beverageTypeId: original?.beverageTypeId ?? beverageTypes[0]?.id ?? "",
            recordedAt: original?.recordedAt ?? new Date().toISOString(),
          };
        } else if (request.resource === "condition") {
          const original = options.editingEntry as ConditionEntry | null;
          target = {
            resource: "condition",
            id: original?.id ?? request.id,
            recordedAt: original?.recordedAt ?? new Date().toISOString(),
          };
        }

        if (target) {
          await handleMutationError(result.error, result.status, {
            target,
            editingEntry: options.editingEntry,
            setEditingEntry: options.setEditingEntry,
          });
        } else {
          setError(result.error.message);
        }
        setLoadingState("idle");
        return false;
      }

      if (options.editingEntry?.id === request.id) {
        options.setEditingEntry?.(null);
      }
      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load, beverageTypes],
  );

  const saveGoal = useCallback(
    async (
      request: Extract<SaveWellnessRequest, { resource: "sleep_goal" | "hydration_goal" }>,
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveWellness(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/${resource}`;
          return false;
        }
        if (isConflictError(result.error)) {
          const listResult = await listWellness(listQuery);
          if (listResult.ok) {
            setEntries(listResult.data.entries as T[]);
            setNextCursor(listResult.data.page.nextCursor);
            setBeverageTypes(listResult.data.beverageTypes);
            setSymptomTypes(listResult.data.symptomTypes);
            setSleepGoals(listResult.data.sleepGoals);
            setHydrationGoals(listResult.data.hydrationGoals);
            setContext(listResult.data.context);
          }
          setConflict({ code: result.error.code, message: result.error.message });
        } else {
          setError(result.error.message);
        }
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [listQuery, load, resource],
  );

  const removeGoal = useCallback(
    async (request: DeleteWellnessRequest): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await deleteWellness(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/${resource}`;
          return false;
        }
        if (isConflictError(result.error)) {
          const listResult = await listWellness(listQuery);
          if (listResult.ok) {
            setEntries(listResult.data.entries as T[]);
            setNextCursor(listResult.data.page.nextCursor);
            setBeverageTypes(listResult.data.beverageTypes);
            setSymptomTypes(listResult.data.symptomTypes);
            setSleepGoals(listResult.data.sleepGoals);
            setHydrationGoals(listResult.data.hydrationGoals);
            setContext(listResult.data.context);
          }
          setConflict({ code: result.error.code, message: result.error.message });
        } else {
          setError(result.error.message);
        }
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [listQuery, load, resource],
  );

  const saveType = useCallback(
    async (
      request: Extract<SaveWellnessRequest, { resource: "beverage_type" | "symptom_type" }>,
    ): Promise<boolean> => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await saveWellness(request);
      if (!result.ok) {
        if (result.status === 401) {
          window.location.href = `/auth?next=/${resource}`;
          return false;
        }
        if (isConflictError(result.error)) {
          const listResult = await listWellness(listQuery);
          if (listResult.ok) {
            setEntries(listResult.data.entries as T[]);
            setNextCursor(listResult.data.page.nextCursor);
            setBeverageTypes(listResult.data.beverageTypes);
            setSymptomTypes(listResult.data.symptomTypes);
            setSleepGoals(listResult.data.sleepGoals);
            setHydrationGoals(listResult.data.hydrationGoals);
            setContext(listResult.data.context);
          }
          setConflict({ code: result.error.code, message: result.error.message });
        } else {
          setError(result.error.message);
        }
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [listQuery, load, resource],
  );

  const toggleArchiveType = useCallback(
    async (type: BeverageType | SymptomType, archived: boolean): Promise<boolean> => {
      const request: SaveWellnessRequest =
        "beverageKey" in type
          ? {
              resource: "beverage_type",
              clientMutationId: generateUuid(),
              type: {
                id: type.id,
                expectedRowVersion: type.rowVersion,
                displayName: type.displayName,
                defaultUnit: type.defaultUnit,
                archived,
              },
            }
          : {
              resource: "symptom_type",
              clientMutationId: generateUuid(),
              type: {
                id: type.id,
                expectedRowVersion: type.rowVersion,
                displayName: type.displayName,
                archived,
              },
            };
      return saveType(request);
    },
    [saveType],
  );

  return {
    entries,
    beverageTypes,
    symptomTypes,
    sleepGoals,
    hydrationGoals,
    context,
    activeBeverageTypes,
    activeSymptomTypes,
    archivedBeverageTypes,
    archivedSymptomTypes,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    load,
    loadMore,
    saveEntry,
    removeEntry,
    saveGoal,
    removeGoal,
    saveType,
    toggleArchiveType,
  };
}

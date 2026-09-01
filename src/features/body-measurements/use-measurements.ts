/**
 * `/measurements` 画面用の状態管理・API 呼び出し Hook。
 *
 * 楽観ロック競合（409）が発生した場合は、サーバー側の最新値を提示して
 * 再試行を促すための情報を状態に保持する（実装仕様書 6.4節）。
 * 目標・種別の競合でも同様に再取得し、編集中の行の rowVersion だけを
 * 最新化して入力内容を保持する（C1/C2/S1）。
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type ArchiveMeasurementTypeRequest,
  type DeleteMeasurementGoalRequest,
  type DeleteMeasurementRequest,
  type Measurement,
  type MeasurementGoal,
  type MeasurementListQuery,
  type MeasurementType,
  type SaveMeasurementGoalRequest,
  type SaveMeasurementRequest,
} from "./schema";
import {
  archiveMeasurementType,
  createMeasurementType,
  deleteGoal,
  deleteMeasurement,
  listGoals,
  listMeasurements,
  saveGoal,
  saveMeasurement,
  seedDefaultTypes,
  type ApiError,
} from "./api";
import { findUnachievedGoal, generateUuid, sortMeasurementsByDate } from "./utils";

type LoadingState = "idle" | "loading" | "submitting";

type ConflictKind = "measurement" | "goal" | "type";

export type ConflictInfo = {
  /** 身体測定APIのエラーコード。 */
  code: string;
  /** サーバーから返されたメッセージ。 */
  message: string;
  /** 競合対象の最新値（あれば）。 */
  target?:
    | { kind: "measurement"; data: Measurement }
    | { kind: "goal"; data: MeasurementGoal }
    | { kind: "type"; data: MeasurementType };
};

export type UseMeasurementsState = {
  measurements: Measurement[];
  types: MeasurementType[];
  context: {
    heightCm: number | null;
    latestWeightKg: number | null;
    latestWeightMeasuredAt: string | null;
    bmi: number | null;
  };
  goals: MeasurementGoal[];
  loadingState: LoadingState;
  error: string | null;
  conflict: ConflictInfo | null;
  filterTypeId: string | "all";
  order: "asc" | "desc";
  from: string;
  to: string;
  selectedTypeId: string | null;
  editingMeasurement: Measurement | null;
  editingGoal: MeasurementGoal | null;
};

const EMPTY_CONTEXT: UseMeasurementsState["context"] = {
  heightCm: null,
  latestWeightKg: null,
  latestWeightMeasuredAt: null,
  bmi: null,
};

function isConflictError(error: ApiError | undefined): boolean {
  return (
    error?.code === "MEASUREMENT_CONFLICT" ||
    error?.code === "MEASUREMENT_DUPLICATE_CONFLICT" ||
    error?.code === "MEASUREMENT_TYPE_CONFLICT" ||
    error?.code === "MEASUREMENT_GOAL_CONFLICT"
  );
}

/**
 * 編集中の行の rowVersion / updatedAt だけを最新化し、
 * 入力中の内容は保持する（S1）。
 */
function refreshRowVersion<T extends { id: string; rowVersion: number; updatedAt: string }>(
  current: T | null,
  latest: T | undefined,
): T | null {
  if (!current || !latest || current.id !== latest.id) {
    return current;
  }
  return { ...current, rowVersion: latest.rowVersion, updatedAt: latest.updatedAt };
}

export function useMeasurements() {
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [types, setTypes] = useState<MeasurementType[]>([]);
  const [context, setContext] = useState<UseMeasurementsState["context"]>(EMPTY_CONTEXT);
  const [goals, setGoals] = useState<MeasurementGoal[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [filterTypeId, setFilterTypeId] = useState<string | "all">("all");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [editingMeasurement, setEditingMeasurement] = useState<Measurement | null>(null);
  const [editingGoal, setEditingGoal] = useState<MeasurementGoal | null>(null);

  const activeTypes = useMemo(
    () =>
      types
        .filter((type) => type.archivedAt === null)
        .sort(
          (a, b) => a.sortOrder - b.sortOrder || a.measurementKey.localeCompare(b.measurementKey),
        ),
    [types],
  );

  const archivedTypes = useMemo(
    () =>
      types
        .filter((type) => type.archivedAt !== null)
        .sort(
          (a, b) => a.sortOrder - b.sortOrder || a.measurementKey.localeCompare(b.measurementKey),
        ),
    [types],
  );

  const listQuery: MeasurementListQuery = useMemo(
    () => ({
      order,
      limit: 100,
      ...(filterTypeId !== "all" ? { typeId: filterTypeId } : {}),
      ...(from ? { from: new Date(from).toISOString() } : {}),
      ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
    }),
    [filterTypeId, from, order, to],
  );

  const filteredMeasurements = useMemo(() => {
    // API側でフィルタ済みの一覧をそのまま並べ替える（S3）。
    return sortMeasurementsByDate(measurements, order);
  }, [measurements, order]);

  const load = useCallback(async () => {
    setLoadingState((prev) => (prev === "submitting" ? "submitting" : "loading"));
    setError(null);
    setConflict(null);

    const result = await listMeasurements(listQuery);
    if (!result.ok) {
      setLoadingState("idle");
      if (result.status === 401) {
        window.location.href = "/auth?next=/measurements";
        return;
      }
      setError(result.error.message);
      return;
    }

    setMeasurements(result.data.measurements);
    setTypes(result.data.types);
    setContext(result.data.context);

    const goalsResult = await listGoals({ includeAchieved: true });
    if (goalsResult.ok) {
      setGoals(goalsResult.data.goals);
    }

    if (result.data.types.length === 0) {
      const seedResult = await seedDefaultTypes();
      if (seedResult.ok) {
        // 既定種別投入後に再取得
        const reload = await listMeasurements(listQuery);
        if (reload.ok) {
          setMeasurements(reload.data.measurements);
          setTypes(reload.data.types);
          setContext(reload.data.context);
        }
      } else if (!seedResult.ok && seedResult.status !== 401) {
        setError(seedResult.error.message);
      }
    }

    setLoadingState("idle");
  }, [listQuery]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleMutationError = useCallback(
    async (
      apiError: ApiError,
      status: number,
      options: { kind: ConflictKind; id?: string } = { kind: "measurement" },
    ) => {
      if (status === 401) {
        window.location.href = "/auth?next=/measurements";
        return;
      }
      if (!isConflictError(apiError)) {
        setError(apiError.message);
        return;
      }

      // 競合時は最新状態を再取得して提示する（実装仕様書 6.4節、C1/C2）。
      const [measurementsResult, goalsResult] = await Promise.all([
        listMeasurements({ order: "desc", limit: 100 }),
        listGoals({ includeAchieved: true }),
      ]);

      if (!measurementsResult.ok || !goalsResult.ok) {
        if (!measurementsResult.ok) {
          setError(measurementsResult.error.message);
        } else if (!goalsResult.ok) {
          setError(goalsResult.error.message);
        } else {
          setError("再取得中にエラーが発生しました。");
        }
        setLoadingState("idle");
        return;
      }

      setMeasurements(measurementsResult.data.measurements);
      setTypes(measurementsResult.data.types);
      setContext(measurementsResult.data.context);
      setGoals(goalsResult.data.goals);

      let target: ConflictInfo["target"] = undefined;

      if (options.id) {
        if (options.kind === "measurement") {
          const latest = measurementsResult.data.measurements.find((m) => m.id === options.id);
          if (latest) {
            target = { kind: "measurement", data: latest };
            setEditingMeasurement((prev) => refreshRowVersion(prev, latest));
          }
        } else if (options.kind === "goal") {
          const latest = goalsResult.data.goals.find((g) => g.id === options.id);
          if (latest) {
            target = { kind: "goal", data: latest };
            setEditingGoal((prev) => refreshRowVersion(prev, latest));
          }
        } else if (options.kind === "type") {
          const latest = measurementsResult.data.types.find((t) => t.id === options.id);
          if (latest) {
            target = { kind: "type", data: latest };
          }
        }
      }

      setConflict({
        code: apiError.code,
        message: apiError.message,
        target,
      });
    },
    [],
  );

  const saveMeasurementRecord = useCallback(
    async (
      input: Omit<SaveMeasurementRequest["measurement"], "id" | "expectedRowVersion"> & {
        id?: string;
        expectedRowVersion?: number;
      },
    ) => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const request: SaveMeasurementRequest = {
        clientMutationId: generateUuid(),
        measurement: {
          typeId: input.typeId,
          measuredAt: input.measuredAt,
          value: input.value,
          unit: input.unit,
          note: input.note ?? null,
          measurementCondition: input.measurementCondition ?? null,
          bodySite: input.bodySite ?? null,
          photoReference: input.photoReference ?? null,
          ...(input.id ? { id: input.id, expectedRowVersion: input.expectedRowVersion } : {}),
        },
      };

      const result = await saveMeasurement(request);
      if (!result.ok) {
        await handleMutationError(result.error, result.status, {
          kind: "measurement",
          id: input.id,
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

  const removeMeasurement = useCallback(
    async (id: string, rowVersion: number) => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const request: DeleteMeasurementRequest = {
        measurementId: id,
        expectedRowVersion: rowVersion,
      };
      const result = await deleteMeasurement(request);
      if (!result.ok) {
        await handleMutationError(result.error, result.status, { kind: "measurement", id });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const addCustomType = useCallback(
    async (type: {
      measurementKey: string;
      displayName: string;
      unitConstraint: MeasurementType["unitConstraint"];
      defaultUnit: MeasurementType["defaultUnit"];
      sortOrder?: number;
    }) => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const result = await createMeasurementType({
        action: "create",
        clientMutationId: generateUuid(),
        type,
      });
      if (!result.ok) {
        await handleMutationError(result.error, result.status, { kind: "type" });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const toggleArchiveType = useCallback(
    async (type: MeasurementType, archived: boolean) => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const request: ArchiveMeasurementTypeRequest = {
        clientMutationId: generateUuid(),
        expectedRowVersion: type.rowVersion,
        archived,
      };
      const result = await archiveMeasurementType(type.id, request);
      if (!result.ok) {
        await handleMutationError(result.error, result.status, { kind: "type", id: type.id });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const saveGoalRecord = useCallback(
    async (
      input: Omit<SaveMeasurementGoalRequest["goal"], "id" | "expectedRowVersion"> & {
        id?: string;
        expectedRowVersion?: number;
      },
    ) => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const request: SaveMeasurementGoalRequest = {
        clientMutationId: generateUuid(),
        goal: {
          typeId: input.typeId,
          targetValue: input.targetValue,
          unit: input.unit,
          startValue: input.startValue ?? null,
          targetDate: input.targetDate ?? null,
          note: input.note ?? null,
          achievedAt: input.achievedAt ?? null,
          ...(input.id ? { id: input.id, expectedRowVersion: input.expectedRowVersion } : {}),
        },
      };

      const result = await saveGoal(request);
      if (!result.ok) {
        await handleMutationError(result.error, result.status, { kind: "goal", id: input.id });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const removeGoal = useCallback(
    async (id: string, rowVersion: number) => {
      setLoadingState("submitting");
      setError(null);
      setConflict(null);

      const request: DeleteMeasurementGoalRequest = { goalId: id, expectedRowVersion: rowVersion };
      const result = await deleteGoal(request);
      if (!result.ok) {
        await handleMutationError(result.error, result.status, { kind: "goal", id });
        setLoadingState("idle");
        return false;
      }

      await load();
      setLoadingState("idle");
      return true;
    },
    [handleMutationError, load],
  );

  const hasUnachievedGoal = useCallback(
    (typeId: string) => findUnachievedGoal(goals, typeId) !== undefined,
    [goals],
  );

  return {
    measurements,
    types,
    activeTypes,
    archivedTypes,
    context,
    goals,
    loadingState,
    error,
    conflict,
    filterTypeId,
    setFilterTypeId,
    order,
    setOrder,
    from,
    setFrom,
    to,
    setTo,
    selectedTypeId,
    setSelectedTypeId,
    filteredMeasurements,
    editingMeasurement,
    setEditingMeasurement,
    editingGoal,
    setEditingGoal,
    load,
    saveMeasurementRecord,
    removeMeasurement,
    addCustomType,
    toggleArchiveType,
    saveGoalRecord,
    removeGoal,
    hasUnachievedGoal,
  };
}

/**
 * `/measurements` 画面用の状態管理・API 呼び出し Hook。
 *
 * 楽観ロック競合（409）が発生した場合は、サーバー側の最新値を提示して
 * 再試行を促すための情報を状態に保持する（実装仕様書 6.4節）。
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

export type ConflictInfo = {
  message: string;
  latest?: Measurement;
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

  const filteredMeasurements = useMemo(() => {
    let result = [...measurements];
    if (filterTypeId !== "all") {
      result = result.filter((m) => m.typeId === filterTypeId);
    }
    if (from) {
      const fromTime = new Date(from).getTime();
      result = result.filter((m) => new Date(m.measuredAt).getTime() >= fromTime);
    }
    if (to) {
      const toTime = new Date(to).getTime();
      result = result.filter((m) => new Date(m.measuredAt).getTime() <= toTime);
    }
    return sortMeasurementsByDate(result, order);
  }, [measurements, filterTypeId, from, to, order]);

  const load = useCallback(async () => {
    setLoadingState((prev) => (prev === "submitting" ? "submitting" : "loading"));
    setError(null);
    setConflict(null);

    const query: MeasurementListQuery = {
      order,
      limit: 100,
    };

    const result = await listMeasurements(query);
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
        const reload = await listMeasurements(query);
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
  }, [order]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleMutationError = useCallback(
    async (apiError: ApiError, status: number, currentId?: string) => {
      if (status === 401) {
        window.location.href = "/auth?next=/measurements";
        return;
      }
      if (isConflictError(apiError)) {
        // 競合時は最新状態を再取得して提示する（実装仕様書 6.4節）
        const latestResult = await listMeasurements({ order: "desc", limit: 100 });
        if (latestResult.ok) {
          setMeasurements(latestResult.data.measurements);
          setTypes(latestResult.data.types);
          setContext(latestResult.data.context);
          const latestMeasurement = currentId
            ? latestResult.data.measurements.find((m) => m.id === currentId)
            : undefined;
          setConflict({
            message: apiError.message,
            latest: latestMeasurement,
          });
        }
      } else {
        setError(apiError.message);
      }
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
        await handleMutationError(result.error, result.status, input.id);
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
        await handleMutationError(result.error, result.status, id);
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
        await handleMutationError(result.error, result.status);
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
        await handleMutationError(result.error, result.status, type.id);
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
        await handleMutationError(result.error, result.status, input.id);
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
        await handleMutationError(result.error, result.status, id);
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SupplementSchedule } from "../schema";
import { useSupplements } from "../use-supplements";
import { generateUuid } from "../utils";
import { ScheduleForm } from "./schedule-form";
import { ScheduleList } from "./schedule-list";
import { ConflictBanner } from "./conflict-banner";
import { SupplementSubnav } from "./supplement-subnav";
import styles from "./supplements.module.css";

export function SchedulePage() {
  const [editingSchedule, setEditingSchedule] = useState<SupplementSchedule | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const mutationIdRef = useRef<string | null>(null);

  const {
    entries,
    products,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    loadMore,
    saveSchedule,
    removeSchedule,
  } = useSupplements<SupplementSchedule>("schedule");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const getMutationId = useCallback(() => {
    if (!mutationIdRef.current) {
      mutationIdRef.current = generateUuid();
    }
    return mutationIdRef.current;
  }, []);

  const clearMutationId = useCallback(() => {
    mutationIdRef.current = null;
  }, []);

  const handleSave = useCallback(
    async (input: {
      id?: string;
      expectedRowVersion?: number;
      productId: string;
      scheduleKind: import("../units").SupplementScheduleKind;
      timeOfDay: string | null;
      timezone: string;
      weekdays: number[] | null;
      startDate: string;
      endDate: string | null;
      amount: number;
      unit: import("../units").SupplementUnit;
      mealRelation: import("../units").SupplementMealRelation;
      note: string | null;
    }) => {
      const request = {
        resource: "schedule" as const,
        clientMutationId: getMutationId(),
        schedule: input,
      };
      const ok = await saveSchedule(request, { editingSchedule, setEditingSchedule });
      if (ok) {
        setEditingSchedule(null);
        clearMutationId();
      }
      return ok;
    },
    [saveSchedule, editingSchedule, getMutationId, clearMutationId],
  );

  const handleDelete = useCallback(
    async (schedule: SupplementSchedule) => {
      if (!window.confirm("この摂取予定を削除してよろしいですか？")) {
        return;
      }
      const request = {
        resource: "schedule" as const,
        id: schedule.id,
        expectedRowVersion: schedule.rowVersion,
      };
      const ok = await removeSchedule(request, { editingSchedule, setEditingSchedule });
      if (ok && editingSchedule?.id === schedule.id) {
        setEditingSchedule(null);
      }
    },
    [removeSchedule, editingSchedule],
  );

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>サプリメント 摂取予定</h1>
        </header>

        <SupplementSubnav current="/supplements/schedules" />

        {error ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {error}
          </p>
        ) : null}
        {isLoading && !isSubmitting ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            読み込み中…
          </p>
        ) : null}

        {conflict ? <ConflictBanner ref={conflictRef} conflict={conflict} /> : null}

        <ScheduleForm
          products={products}
          editingSchedule={editingSchedule}
          onSubmit={handleSave}
          onCancel={() => {
            setEditingSchedule(null);
            clearMutationId();
          }}
          disabled={isSubmitting}
          serverError={error}
        />

        <section className={styles.card} aria-labelledby="schedule-list-heading">
          <h2 className={styles.sectionTitle} id="schedule-list-heading">
            摂取予定一覧
          </h2>
          <ScheduleList
            schedules={entries}
            onEdit={setEditingSchedule}
            onDelete={handleDelete}
            disabled={isSubmitting}
          />
          {nextCursor ? (
            <div className={styles.loadMore}>
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                type="button"
                onClick={() => void loadMore()}
                disabled={isSubmitting || isLoadingMore}
              >
                {isLoadingMore ? "読み込み中…" : "もっと見る"}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

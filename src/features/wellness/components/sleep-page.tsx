"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SleepEntry, SleepGoal } from "../schema";
import { useWellness } from "../use-wellness";
import { listWellness } from "../api";
import { buildSleepCsv, downloadCsv, generateUuid } from "../utils";
import { SleepForm } from "./sleep-form";
import { SleepList } from "./sleep-list";
import { WellnessChart } from "./wellness-chart";
import { GoalManager } from "./goal-manager";
import { ConflictBanner } from "./conflict-banner";
import styles from "../wellness.module.css";

const TABS = [
  { key: "records", label: "睡眠記録" },
  { key: "goals", label: "目標" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function SleepPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("records");
  const [editingEntry, setEditingEntry] = useState<SleepEntry | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);

  const {
    entries,
    sleepGoals,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    loadMore,
    saveEntry,
    removeEntry,
    saveGoal,
    removeGoal,
  } = useWellness<SleepEntry>("sleep");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const handleSave = useCallback(
    async (input: {
      id?: string;
      expectedRowVersion?: number;
      sleepKind: "night" | "nap" | "other";
      bedAt: string;
      sleepAt: string;
      wakeAt: string;
      outOfBedAt: string;
      timezone: string;
      awakeningsCount: number;
      awakeMinutes: number;
      quality: number | null;
      morningFeeling: number | null;
      note: string | null;
    }) => {
      setFormError(null);
      const request = {
        resource: "sleep" as const,
        clientMutationId: generateUuid(),
        entry: input,
      };
      const ok = await saveEntry(request, { editingEntry, setEditingEntry });
      if (ok) {
        setEditingEntry(null);
      }
      return ok;
    },
    [saveEntry, editingEntry],
  );

  const handleDelete = useCallback(
    async (entry: SleepEntry) => {
      if (!window.confirm("この睡眠記録を削除してよろしいですか？")) {
        return;
      }
      const request = {
        resource: "sleep" as const,
        id: entry.id,
        expectedRowVersion: entry.rowVersion,
      };
      const ok = await removeEntry(request, { editingEntry, setEditingEntry });
      if (ok && editingEntry?.id === entry.id) {
        setEditingEntry(null);
      }
    },
    [removeEntry, editingEntry],
  );

  const handleExportCsv = useCallback(async () => {
    setCsvLoading(true);
    setFormError(null);
    const all: SleepEntry[] = [];
    let cursor: string | undefined;
    do {
      const result = await listWellness({
        resource: "sleep",
        order: "desc",
        limit: 500,
        cursor,
      });
      if (!result.ok) {
        setFormError(result.error.message);
        setCsvLoading(false);
        return;
      }
      all.push(...(result.data.entries as SleepEntry[]));
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    const csv = buildSleepCsv(all);
    downloadCsv(`sleep-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    setCsvLoading(false);
  }, []);

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>睡眠</h1>
          {sleepGoals.find((g) => g.endDate === null) ? (
            <p className={styles.statusInfo}>
              目標: {(sleepGoals.find((g) => g.endDate === null) as SleepGoal).targetSleepMinutes}分
            </p>
          ) : null}
        </header>

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

        <div className={styles.tabs} role="tablist" aria-label="睡眠タブ">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={styles.tab}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`sleep-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "records" ? (
          <div id="sleep-panel-records" role="tabpanel" aria-labelledby="sleep-tab-records">
            {formError ? (
              <p className={`${styles.status} ${styles.statusError}`} role="alert">
                {formError}
              </p>
            ) : null}
            {conflict ? <ConflictBanner ref={conflictRef} conflict={conflict} /> : null}

            <button
              className={`${styles.button} ${styles.buttonSecondary}`}
              type="button"
              onClick={handleExportCsv}
              disabled={isSubmitting || csvLoading}
            >
              {csvLoading ? "出力中…" : "CSV出力"}
            </button>

            <SleepForm
              editingEntry={editingEntry}
              onSubmit={handleSave}
              onCancel={() => setEditingEntry(null)}
              disabled={isSubmitting}
              serverError={error}
            />

            <WellnessChart
              entries={entries}
              dataKey="sleepMinutes"
              yLabel="睡眠時間（分）"
              targetValue={sleepGoals.find((g) => g.endDate === null)?.targetSleepMinutes}
              targetLabel="目標"
              valueFormatter={(value) => `${Math.floor(value / 60)}時間${value % 60}分`}
            />

            <section className={styles.card} aria-labelledby="sleep-list-heading">
              <h2 className={styles.sectionTitle} id="sleep-list-heading">
                睡眠記録一覧
              </h2>
              <SleepList
                entries={entries}
                onEdit={setEditingEntry}
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
        ) : null}

        {activeTab === "goals" ? (
          <div id="sleep-panel-goals" role="tabpanel" aria-labelledby="sleep-tab-goals">
            <GoalManager
              resource="sleep"
              goals={sleepGoals}
              onSave={async (goal) =>
                saveGoal({
                  resource: "sleep_goal",
                  clientMutationId: generateUuid(),
                  goal: goal as import("../schema").SleepGoalInput,
                })
              }
              onDelete={async (goal) =>
                removeGoal({
                  resource: "sleep_goal",
                  id: goal.id,
                  expectedRowVersion: goal.rowVersion,
                })
              }
              disabled={isSubmitting}
              serverError={error}
              conflict={conflict}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}

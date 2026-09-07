"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HydrationGoal, SleepEntry, SleepGoal } from "../schema";
import { useWellness } from "../use-wellness";
import { listWellness } from "../api";
import { buildSleepCsv, downloadCsv, formatMinutes, generateUuid, meanBy } from "../utils";
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
  const [editingGoal, setEditingGoal] = useState<SleepGoal | HydrationGoal | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);
  const clientMutationIdRef = useRef<string | null>(null);

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

  const getClientMutationId = useCallback(() => {
    if (!clientMutationIdRef.current) {
      clientMutationIdRef.current = generateUuid();
    }
    return clientMutationIdRef.current;
  }, []);

  const clearClientMutationId = useCallback(() => {
    clientMutationIdRef.current = null;
  }, []);

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
        clientMutationId: getClientMutationId(),
        entry: input,
      };
      const ok = await saveEntry(request, { editingEntry, setEditingEntry });
      if (ok) {
        setEditingEntry(null);
        clearClientMutationId();
      }
      return ok;
    },
    [saveEntry, editingEntry, getClientMutationId, clearClientMutationId],
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

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const nextIndex =
      event.key === "ArrowLeft"
        ? (index - 1 + TABS.length) % TABS.length
        : (index + 1) % TABS.length;
    setActiveTab(TABS[nextIndex].key);
    requestAnimationFrame(() => {
      const tab = document.getElementById(`sleep-tab-${TABS[nextIndex].key}`);
      tab?.focus();
    });
  }, []);

  const averageSleepMinutes = useMemo(
    () => meanBy(entries, (entry) => entry.sleepMinutes),
    [entries],
  );

  const activeGoal = useMemo(() => sleepGoals.find((g) => g.endDate === null), [sleepGoals]);

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>睡眠</h1>
          {activeGoal ? (
            <p className={styles.statusInfo}>目標: {activeGoal.targetSleepMinutes}分</p>
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
          {TABS.map((tab, index) => (
            <button
              key={tab.key}
              id={`sleep-tab-${tab.key}`}
              className={styles.tab}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`sleep-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
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
            {conflict ? (
              <div>
                <ConflictBanner ref={conflictRef} conflict={conflict} />
                {conflict.target?.kind === "entry" ? (
                  <p className={`${styles.status} ${styles.statusInfo}`} role="status">
                    サーバーの最新値: 睡眠{" "}
                    {formatMinutes((conflict.target.data as SleepEntry).sleepMinutes)} @{" "}
                    {new Date((conflict.target.data as SleepEntry).sleepAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            ) : null}

            <button
              className={`${styles.button} ${styles.buttonSecondary}`}
              type="button"
              onClick={handleExportCsv}
              disabled={isSubmitting || csvLoading}
            >
              {csvLoading ? "出力中…" : "CSV出力"}
            </button>

            {entries.length > 0 ? (
              <p className={`${styles.status} ${styles.statusInfo}`} role="status">
                平均睡眠時間: {formatMinutes(Math.round(averageSleepMinutes ?? 0))}
                {averageSleepMinutes !== null ? (
                  <span className={styles.statusSecondary}> （{entries.length}件）</span>
                ) : null}
              </p>
            ) : null}

            <SleepForm
              editingEntry={editingEntry}
              onSubmit={handleSave}
              onCancel={() => {
                setEditingEntry(null);
                clearClientMutationId();
              }}
              disabled={isSubmitting}
              serverError={error}
            />

            <WellnessChart
              entries={entries}
              dataKey="sleepMinutes"
              yLabel="睡眠時間（分）"
              targetValue={activeGoal?.targetSleepMinutes}
              targetLabel="目標"
              valueFormatter={(value) => `${Math.floor(value / 60)}時間${value % 60}分`}
            />

            <section className={styles.card} aria-labelledby="sleep-list-heading">
              <h2 className={styles.sectionTitle} id="sleep-list-heading">
                睡眠記録一覧
                <span className={styles.statusSecondary}>※効率は推定値です</span>
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
            {conflict ? <ConflictBanner ref={conflictRef} conflict={conflict} /> : null}
            <GoalManager
              resource="sleep"
              goals={sleepGoals}
              editingGoal={editingGoal}
              onSetEditingGoal={setEditingGoal}
              onSave={async (goal) => {
                const ok = await saveGoal(
                  {
                    resource: "sleep_goal",
                    clientMutationId: getClientMutationId(),
                    goal: goal as import("../schema").SleepGoalInput,
                  },
                  { editingGoal, setEditingGoal },
                );
                if (ok) {
                  clearClientMutationId();
                }
                return ok;
              }}
              onDelete={async (goal) => {
                const ok = await removeGoal(
                  {
                    resource: "sleep_goal",
                    id: goal.id,
                    expectedRowVersion: goal.rowVersion,
                  },
                  { editingGoal, setEditingGoal },
                );
                if (ok && editingGoal?.id === goal.id) {
                  setEditingGoal(null);
                }
                return ok;
              }}
              disabled={isSubmitting}
              serverError={error}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}

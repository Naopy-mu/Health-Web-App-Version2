"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BeverageType, HydrationEntry, HydrationGoal } from "../schema";
import { useWellness } from "../use-wellness";
import { listWellness } from "../api";
import { buildHydrationCsv, downloadCsv, generateUuid } from "../utils";
import { HydrationForm } from "./hydration-form";
import { HydrationList } from "./hydration-list";
import { WellnessChart } from "./wellness-chart";
import { GoalManager } from "./goal-manager";
import { TypeManager } from "./type-manager";
import { ConflictBanner } from "./conflict-banner";
import styles from "../wellness.module.css";

const TABS = [
  { key: "records", label: "水分記録" },
  { key: "goals", label: "目標" },
  { key: "types", label: "飲み物種別" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function HydrationPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("records");
  const [editingEntry, setEditingEntry] = useState<HydrationEntry | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);

  const {
    entries,
    beverageTypes,
    activeBeverageTypes,
    archivedBeverageTypes,
    hydrationGoals,
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
    saveType,
    toggleArchiveType,
  } = useWellness<HydrationEntry>("hydration");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const handleSave = useCallback(
    async (input: {
      id?: string;
      expectedRowVersion?: number;
      beverageTypeId: string;
      recordedAt: string;
      amount: number;
      unit: "ml" | "l" | "us_fl_oz";
      containsCaffeine: boolean;
      containsAlcohol: boolean;
      note: string | null;
    }) => {
      setFormError(null);
      const request = {
        resource: "hydration" as const,
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
    async (entry: HydrationEntry) => {
      if (!window.confirm("この水分記録を削除してよろしいですか？")) {
        return;
      }
      const request = {
        resource: "hydration" as const,
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

  const handleQuickAdd = useCallback(
    async (type: BeverageType) => {
      setFormError(null);
      const amount = type.defaultAmount ?? (type.defaultUnit === "l" ? 0.5 : 200);
      const request = {
        resource: "hydration" as const,
        clientMutationId: generateUuid(),
        entry: {
          beverageTypeId: type.id,
          recordedAt: new Date().toISOString(),
          amount,
          unit: type.defaultUnit,
          containsCaffeine: type.containsCaffeine,
          containsAlcohol: type.containsAlcohol,
          note: null as string | null,
        },
      };
      const ok = await saveEntry(request, { editingEntry, setEditingEntry });
      if (ok) {
        setEditingEntry(null);
      }
    },
    [saveEntry, editingEntry],
  );

  const handleExportCsv = useCallback(async () => {
    setCsvLoading(true);
    setFormError(null);
    const all: HydrationEntry[] = [];
    let cursor: string | undefined;
    do {
      const result = await listWellness({
        resource: "hydration",
        order: "desc",
        limit: 500,
        cursor,
      });
      if (!result.ok) {
        setFormError(result.error.message);
        setCsvLoading(false);
        return;
      }
      all.push(...(result.data.entries as HydrationEntry[]));
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    const csv = buildHydrationCsv(all);
    downloadCsv(`hydration-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    setCsvLoading(false);
  }, []);

  const handleCreateType = useCallback(
    async (type: {
      key: string;
      displayName: string;
      defaultUnit?: "ml" | "l" | "us_fl_oz";
      defaultAmount?: number | null;
      containsCaffeine?: boolean;
      containsAlcohol?: boolean;
      sortOrder?: number;
    }) => {
      const request = {
        resource: "beverage_type" as const,
        clientMutationId: generateUuid(),
        type: {
          beverageKey: type.key,
          displayName: type.displayName,
          defaultUnit: type.defaultUnit ?? "ml",
          defaultAmount: type.defaultAmount ?? null,
          containsCaffeine: type.containsCaffeine ?? false,
          containsAlcohol: type.containsAlcohol ?? false,
          sortOrder: type.sortOrder ?? 1000,
        },
      };
      return saveType(request);
    },
    [saveType],
  );

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>水分</h1>
          {hydrationGoals.find((g) => g.endDate === null) ? (
            <p className={styles.statusInfo}>
              目標:{" "}
              {(hydrationGoals.find((g) => g.endDate === null) as HydrationGoal).targetAmountMl}ml
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

        <div className={styles.tabs} role="tablist" aria-label="水分タブ">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={styles.tab}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`hydration-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "records" ? (
          <div id="hydration-panel-records" role="tabpanel" aria-labelledby="hydration-tab-records">
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

            <section className={styles.card} aria-labelledby="quick-add-heading">
              <h2 className={styles.sectionTitle} id="quick-add-heading">
                クイック追加
              </h2>
              <div className={styles.quickAddGrid}>
                {activeBeverageTypes.map((type) => (
                  <button
                    key={type.id}
                    className={styles.quickAddButton}
                    type="button"
                    onClick={() => void handleQuickAdd(type)}
                    disabled={isSubmitting}
                  >
                    {type.displayName}
                    {type.defaultAmount ? ` (${type.defaultAmount}${type.defaultUnit})` : ""}
                  </button>
                ))}
              </div>
            </section>

            <HydrationForm
              beverageTypes={activeBeverageTypes}
              editingEntry={editingEntry}
              onSubmit={handleSave}
              onCancel={() => setEditingEntry(null)}
              disabled={isSubmitting}
              serverError={error}
            />

            <WellnessChart
              entries={entries}
              dataKey="amountMl"
              yLabel="水分量（ml）"
              targetValue={hydrationGoals.find((g) => g.endDate === null)?.targetAmountMl}
              targetLabel="目標"
              valueFormatter={(value) => `${value}ml`}
            />

            <section className={styles.card} aria-labelledby="hydration-list-heading">
              <h2 className={styles.sectionTitle} id="hydration-list-heading">
                水分記録一覧
              </h2>
              <HydrationList
                entries={entries}
                beverageTypes={beverageTypes}
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
          <div id="hydration-panel-goals" role="tabpanel" aria-labelledby="hydration-tab-goals">
            <GoalManager
              resource="hydration"
              goals={hydrationGoals}
              onSave={async (goal) =>
                saveGoal({
                  resource: "hydration_goal",
                  clientMutationId: generateUuid(),
                  goal: goal as import("../schema").HydrationGoalInput,
                })
              }
              onDelete={async (goal) =>
                removeGoal({
                  resource: "hydration_goal",
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

        {activeTab === "types" ? (
          <div id="hydration-panel-types" role="tabpanel" aria-labelledby="hydration-tab-types">
            <TypeManager
              resource="hydration"
              activeTypes={activeBeverageTypes}
              archivedTypes={archivedBeverageTypes}
              onCreate={handleCreateType}
              onArchiveToggle={toggleArchiveType}
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

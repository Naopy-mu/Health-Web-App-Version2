"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConditionEntry, SymptomType } from "../schema";
import { useWellness } from "../use-wellness";
import { listWellness } from "../api";
import { buildConditionCsv, downloadCsv, generateUuid } from "../utils";
import { ConditionForm } from "./condition-form";
import { ConditionList } from "./condition-list";
import { TypeManager } from "./type-manager";
import { ConflictBanner } from "./conflict-banner";
import styles from "../wellness.module.css";

const TABS = [
  { key: "records", label: "体調記録" },
  { key: "types", label: "症状種別" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function ConditionPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("records");
  const [editingEntry, setEditingEntry] = useState<ConditionEntry | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);

  const {
    entries,
    activeSymptomTypes,
    archivedSymptomTypes,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    loadMore,
    saveEntry,
    removeEntry,
    saveType,
    toggleArchiveType,
  } = useWellness<ConditionEntry>("condition");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const handleSave = useCallback(
    async (input: {
      id?: string;
      expectedRowVersion?: number;
      recordedAt: string;
      timezone: string;
      overallScore: number | null;
      fatigueScore: number | null;
      energyScore: number | null;
      stressScore: number | null;
      painScore: number | null;
      moodScore: number | null;
      bodyTemperatureC: number | null;
      freeTextSymptoms: string[];
      symptoms: { symptomTypeId: string; severity: number | null; note: string | null }[];
      note: string | null;
    }) => {
      setFormError(null);
      const request = {
        resource: "condition" as const,
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
    async (entry: ConditionEntry) => {
      if (!window.confirm("この体調記録を削除してよろしいですか？")) {
        return;
      }
      const request = {
        resource: "condition" as const,
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
    const all: ConditionEntry[] = [];
    let cursor: string | undefined;
    do {
      const result = await listWellness({
        resource: "condition",
        order: "desc",
        limit: 500,
        cursor,
      });
      if (!result.ok) {
        setFormError(result.error.message);
        setCsvLoading(false);
        return;
      }
      all.push(...(result.data.entries as ConditionEntry[]));
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    const csv = buildConditionCsv(all);
    downloadCsv(`condition-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    setCsvLoading(false);
  }, []);

  const handleCreateType = useCallback(
    async (type: { key: string; displayName: string; sortOrder?: number }) => {
      const request = {
        resource: "symptom_type" as const,
        clientMutationId: generateUuid(),
        type: {
          symptomKey: type.key,
          displayName: type.displayName,
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
          <h1 className={styles.title}>体調</h1>
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

        <div className={styles.tabs} role="tablist" aria-label="体調タブ">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={styles.tab}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`condition-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "records" ? (
          <div id="condition-panel-records" role="tabpanel" aria-labelledby="condition-tab-records">
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

            <ConditionForm
              symptomTypes={activeSymptomTypes as SymptomType[]}
              editingEntry={editingEntry}
              onSubmit={handleSave}
              onCancel={() => setEditingEntry(null)}
              disabled={isSubmitting}
              serverError={error}
            />

            <section className={styles.card} aria-labelledby="condition-list-heading">
              <h2 className={styles.sectionTitle} id="condition-list-heading">
                体調記録一覧
              </h2>
              <ConditionList
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

        {activeTab === "types" ? (
          <div id="condition-panel-types" role="tabpanel" aria-labelledby="condition-tab-types">
            <TypeManager
              resource="condition"
              activeTypes={activeSymptomTypes}
              archivedTypes={archivedSymptomTypes}
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

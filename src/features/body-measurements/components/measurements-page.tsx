"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Measurement } from "../schema";
import { listMeasurements } from "../api";
import { useMeasurements } from "../use-measurements";
import { buildMeasurementsCsv, downloadCsv, formatValue } from "../utils";
import { MeasurementChart } from "./measurement-chart";
import { RecordForm } from "./record-form";
import { RecordList } from "./record-list";
import { TypeManager } from "./type-manager";
import { GoalManager } from "./goal-manager";
import { ConflictBanner } from "./conflict-banner";
import styles from "../measurements.module.css";

const TABS = [
  { key: "records", label: "測定記録" },
  { key: "types", label: "種別管理" },
  { key: "goals", label: "目標" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function MeasurementsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("records");
  const [formError, setFormError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const conflictRef = useRef<HTMLDivElement>(null);

  const {
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
    nextCursor,
    isLoadingMore,
    loadMore,
    saveMeasurementRecord,
    removeMeasurement,
    addCustomType,
    toggleArchiveType,
    saveGoalRecord,
    removeGoal,
  } = useMeasurements();

  // 競合バナー表示時にフォーカスを移動する（S2）。
  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const selectedType = useMemo(
    () => activeTypes.find((type) => type.id === selectedTypeId) ?? activeTypes[0],
    [activeTypes, selectedTypeId],
  );

  const chartMeasurements = useMemo(() => {
    if (!selectedType) {
      return [];
    }
    return filteredMeasurements.filter((m) => m.typeId === selectedType.id);
  }, [filteredMeasurements, selectedType]);

  const handleSaveMeasurement = useCallback(
    async (input: Parameters<typeof saveMeasurementRecord>[0]) => {
      setFormError(null);
      const ok = await saveMeasurementRecord(input);
      if (ok) {
        setEditingMeasurement(null);
      }
    },
    [saveMeasurementRecord, setEditingMeasurement],
  );

  const handleDeleteMeasurement = useCallback(
    async (measurement: Measurement) => {
      if (!window.confirm("この測定記録を削除してよろしいですか？")) {
        return;
      }
      const ok = await removeMeasurement(measurement);
      if (ok && editingMeasurement?.id === measurement.id) {
        setEditingMeasurement(null);
      }
    },
    [editingMeasurement?.id, removeMeasurement, setEditingMeasurement],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMeasurement(null);
  }, [setEditingMeasurement]);

  const handleExportCsv = useCallback(async () => {
    setCsvLoading(true);
    setFormError(null);
    // API には CSV 用エンドポイントが無いため、ページングで全件取得してクライアント側で組み立てる
    const all: Measurement[] = [];
    let cursor: string | undefined;
    do {
      const result = await listMeasurements({
        order: "desc",
        limit: 500,
        cursor,
      });
      if (!result.ok) {
        setFormError(result.error.message);
        setCsvLoading(false);
        return;
      }
      all.push(...result.data.measurements);
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    const csv = buildMeasurementsCsv(all);
    downloadCsv(`measurements-${new Date().toISOString().slice(0, 10)}.csv`, csv);
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
    // 次のレンダー後にフォーカスを当てる
    requestAnimationFrame(() => {
      const tab = document.getElementById(`measurements-tab-${TABS[nextIndex].key}`);
      tab?.focus();
    });
  }, []);

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>身体測定</h1>
          {context.bmi !== null ? (
            <p className={styles.statusInfo}>
              最新BMI: {context.bmi} / 体重: {context.latestWeightKg}kg
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

        <div className={styles.tabs} role="tablist" aria-label="身体測定タブ">
          {TABS.map((tab, index) => (
            <button
              key={tab.key}
              id={`measurements-tab-${tab.key}`}
              className={styles.tab}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`measurements-panel-${tab.key}`}
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
          <div
            id="measurements-panel-records"
            role="tabpanel"
            aria-labelledby="measurements-tab-records"
          >
            <section className={styles.card} aria-labelledby="filters-heading">
              <h2 className={styles.sectionTitle} id="filters-heading">
                フィルタ・並び替え
              </h2>
              {formError ? (
                <p className={`${styles.status} ${styles.statusError}`} role="alert">
                  {formError}
                </p>
              ) : null}
              <div className={styles.filters}>
                <div className={styles.filterField}>
                  <label className={styles.label} htmlFor="filter-type">
                    種別
                  </label>
                  <select
                    id="filter-type"
                    className={styles.select}
                    value={filterTypeId}
                    onChange={(event) => setFilterTypeId(event.target.value)}
                  >
                    <option value="all">すべて</option>
                    {activeTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.filterField}>
                  <label className={styles.label} htmlFor="filter-from">
                    開始日
                  </label>
                  <input
                    id="filter-from"
                    className={styles.input}
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </div>
                <div className={styles.filterField}>
                  <label className={styles.label} htmlFor="filter-to">
                    終了日
                  </label>
                  <input
                    id="filter-to"
                    className={styles.input}
                    type="date"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </div>
                <div className={styles.filterField}>
                  <label className={styles.label} htmlFor="filter-order">
                    並び順
                  </label>
                  <select
                    id="filter-order"
                    className={styles.select}
                    value={order}
                    onChange={(event) => setOrder(event.target.value as "asc" | "desc")}
                  >
                    <option value="desc">新しい順</option>
                    <option value="asc">古い順</option>
                  </select>
                </div>
                <button
                  className={`${styles.button} ${styles.buttonSecondary}`}
                  type="button"
                  onClick={handleExportCsv}
                  disabled={isSubmitting || csvLoading}
                >
                  {csvLoading ? "出力中…" : "CSV出力"}
                </button>
              </div>
            </section>

            {conflict ? (
              <div>
                <ConflictBanner ref={conflictRef} conflict={conflict} />
                {conflict.target?.kind === "measurement" ? (
                  <p className={`${styles.status} ${styles.statusInfo}`} role="status">
                    サーバーの最新値:{" "}
                    {formatValue(conflict.target.data.value, conflict.target.data.unit)} @{" "}
                    {new Date(conflict.target.data.measuredAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            ) : null}

            <RecordForm
              activeTypes={activeTypes}
              editingMeasurement={editingMeasurement}
              onSubmit={handleSaveMeasurement}
              onCancel={handleCancelEdit}
              disabled={isSubmitting}
              serverError={error}
            />

            {selectedType ? (
              <MeasurementChart
                measurements={chartMeasurements}
                selectedType={selectedType}
                goals={goals}
              />
            ) : null}

            <section className={styles.card} aria-labelledby="records-heading">
              <div className={styles.header}>
                <h2 className={styles.sectionTitle} id="records-heading">
                  測定記録一覧
                </h2>
                {selectedType ? (
                  <label className={styles.label} htmlFor="chart-type">
                    グラフ対象種別
                  </label>
                ) : null}
                {selectedType ? (
                  <select
                    id="chart-type"
                    className={styles.select}
                    value={selectedTypeId ?? selectedType.id}
                    onChange={(event) => setSelectedTypeId(event.target.value)}
                  >
                    {activeTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.displayName}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              <RecordList
                measurements={filteredMeasurements}
                types={types}
                onEdit={setEditingMeasurement}
                onDelete={handleDeleteMeasurement}
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
          <div
            id="measurements-panel-types"
            role="tabpanel"
            aria-labelledby="measurements-tab-types"
          >
            <TypeManager
              activeTypes={activeTypes}
              archivedTypes={archivedTypes}
              onCreate={addCustomType}
              onArchiveToggle={toggleArchiveType}
              disabled={isSubmitting}
              serverError={error}
              conflict={conflict}
            />
          </div>
        ) : null}

        {activeTab === "goals" ? (
          <div
            id="measurements-panel-goals"
            role="tabpanel"
            aria-labelledby="measurements-tab-goals"
          >
            <GoalManager
              types={types}
              activeTypes={activeTypes}
              goals={goals}
              editingGoal={editingGoal}
              onSetEditingGoal={setEditingGoal}
              onSave={saveGoalRecord}
              onDelete={removeGoal}
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

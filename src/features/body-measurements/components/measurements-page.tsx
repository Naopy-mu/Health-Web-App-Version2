"use client";

import { useCallback, useMemo, useState } from "react";

import type { Measurement } from "../schema";
import { listMeasurements } from "../api";
import { useMeasurements } from "../use-measurements";
import { buildMeasurementsCsv, downloadCsv, formatValue } from "../utils";
import { MeasurementChart } from "./measurement-chart";
import { RecordForm } from "./record-form";
import { RecordList } from "./record-list";
import { TypeManager } from "./type-manager";
import { GoalManager } from "./goal-manager";
import styles from "../measurements.module.css";

const TABS = [
  { key: "records", label: "測定記録" },
  { key: "types", label: "種別管理" },
  { key: "goals", label: "目標" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function MeasurementsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("records");
  const [editingMeasurement, setEditingMeasurement] = useState<Measurement | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);

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
    saveMeasurementRecord,
    removeMeasurement,
    addCustomType,
    toggleArchiveType,
    saveGoalRecord,
    removeGoal,
  } = useMeasurements();

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
    [saveMeasurementRecord],
  );

  const handleDeleteMeasurement = useCallback(
    async (measurement: Measurement) => {
      if (!window.confirm("この測定記録を削除してよろしいですか？")) {
        return;
      }
      const ok = await removeMeasurement(measurement.id, measurement.rowVersion);
      if (ok && editingMeasurement?.id === measurement.id) {
        setEditingMeasurement(null);
      }
    },
    [editingMeasurement?.id, removeMeasurement],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMeasurement(null);
  }, []);

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
        {conflict ? (
          <div className={`${styles.status} ${styles.statusError}`} role="alert">
            <p>{conflict.message}</p>
            {conflict.latest ? (
              <p>
                サーバーの最新値: {formatValue(conflict.latest.value, conflict.latest.unit)} @{" "}
                {new Date(conflict.latest.measuredAt).toLocaleString()}
              </p>
            ) : null}
            <p>一覧を確認し、必要に応じて再試行してください。</p>
          </div>
        ) : null}
        {isLoading && !isSubmitting ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            読み込み中…
          </p>
        ) : null}

        <div className={styles.tabs} role="tablist" aria-label="身体測定タブ">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={styles.tab}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "records" ? (
          <>
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
            </section>
          </>
        ) : null}

        {activeTab === "types" ? (
          <TypeManager
            activeTypes={activeTypes}
            archivedTypes={archivedTypes}
            onCreate={addCustomType}
            onArchiveToggle={toggleArchiveType}
            disabled={isSubmitting}
            serverError={error}
          />
        ) : null}

        {activeTab === "goals" ? (
          <GoalManager
            activeTypes={activeTypes}
            goals={goals}
            onSave={saveGoalRecord}
            onDelete={removeGoal}
            disabled={isSubmitting}
            serverError={error}
          />
        ) : null}
      </div>
    </main>
  );
}

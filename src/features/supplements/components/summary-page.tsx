"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { SupplementIntake, SupplementLot, SupplementSchedule } from "../schema";
import { useSupplements } from "../use-supplements";
import { listSupplements } from "../api";
import { unitLabel } from "../labels";
import {
  buildRetryIntakeIdempotencyKey,
  buildScheduledIntakeIdempotencyKey,
  expandSchedulesForDate,
  findIntakeForOccurrence,
  formatDateTimeJa,
  generateUuid,
  localDateInTimezone,
} from "../utils";
import { IntakeForm, type IntakeFormOccurrence } from "./intake-form";
import { SupplementSubnav } from "./supplement-subnav";
import styles from "./supplements.module.css";

export function SummaryPage() {
  const [schedules, setSchedules] = useState<SupplementSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [selectedOccurrence, setSelectedOccurrence] = useState<IntakeFormOccurrence | null>(null);
  const [intakeInfo, setIntakeInfo] = useState<string | null>(null);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  const {
    entries: intakes,
    products,
    summary,
    loadingState,
    error,
    load,
    recordIntake,
  } = useSupplements<SupplementIntake>("intake");
  const { entries: lots } = useSupplements<SupplementLot>("lot");

  const loadSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    const result = await listSupplements({ resource: "schedule", order: "desc", limit: 500 });
    if (!result.ok) {
      if (result.status === 401) {
        window.location.href = `/auth?next=/supplements`;
        return;
      }
      setSchedulesError(result.error.message);
    } else {
      setSchedules(result.data.entries as SupplementSchedule[]);
      setSchedulesError(null);
    }
    setSchedulesLoading(false);
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleRecordIntake = useCallback(
    async (input: {
      productId: string;
      idempotencyKey: string;
      recordedAt: string;
      status: import("../units").SupplementRecordableStatus;
      amount: number;
      unit: import("../units").SupplementUnit;
      scheduleId: string | null;
      scheduledFor: string | null;
      consumeQuantity: number | undefined;
      note: string | null;
    }) => {
      setIntakeError(null);
      setIntakeInfo(null);
      const request = {
        resource: "intake" as const,
        clientMutationId: generateUuid(),
        intake: input,
      };
      const result = await recordIntake(request);
      if (!result.ok) {
        setIntakeError(result.error ?? "記録に失敗しました。");
        return;
      }
      if (result.outcome === "idempotent_replay") {
        setIntakeInfo("同じ記録が既に存在するため、在庫・履歴は追加されていません。");
      }
      await load();
      await loadSchedules();
      setSelectedOccurrence(null);
    },
    [recordIntake, load, loadSchedules],
  );

  const handleSelectOccurrence = useCallback(
    (occurrence: import("../utils").ScheduleOccurrence) => {
      const baseKey = buildScheduledIntakeIdempotencyKey(
        occurrence.scheduleId,
        occurrence.scheduledFor,
      );
      setIntakeError(null);
      setIntakeInfo(null);
      setSelectedOccurrence({
        scheduleId: occurrence.scheduleId,
        scheduledFor: occurrence.scheduledFor,
        productId: occurrence.productId,
        amount: occurrence.amount,
        unit: occurrence.unit,
        idempotencyKey: buildRetryIntakeIdempotencyKey(baseKey, intakes),
      });
    },
    [intakes],
  );

  const today = useMemo(() => new Date(), []);
  const todayLocal = useMemo(() => localDateInTimezone(today, "Asia/Tokyo"), [today]);
  const todayOccurrences = useMemo(
    () => expandSchedulesForDate(schedules, today, "Asia/Tokyo"),
    [schedules, today],
  );

  const lowStockProducts = useMemo(
    () => products.filter((p) => p.archivedAt === null && p.stock.lowStock),
    [products],
  );

  const isLoading = loadingState !== "idle" || schedulesLoading;

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>サプリメント</h1>
        </header>

        <SupplementSubnav current="/supplements" />

        {error || schedulesError || intakeError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {intakeError ?? error ?? schedulesError}
          </p>
        ) : null}
        {intakeInfo ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            {intakeInfo}
          </p>
        ) : null}
        {isLoading ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            読み込み中…
          </p>
        ) : null}

        {summary ? (
          <div className={styles.summaryGrid} role="status" aria-label="サプリメント概要">
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{summary.weeklyScheduledCount}</p>
              <p className={styles.summaryLabel}>週の予定</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{summary.weeklyTakenCount}</p>
              <p className={styles.summaryLabel}>週の服用</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{summary.monthlyTakenCount}</p>
              <p className={styles.summaryLabel}>月の服用</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{summary.lowStockProductCount}</p>
              <p className={styles.summaryLabel}>低在庫商品</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{summary.expiringLotCount}</p>
              <p className={styles.summaryLabel}>期限接近ロット</p>
            </div>
          </div>
        ) : null}

        {selectedOccurrence ? (
          <IntakeForm
            products={products}
            lots={lots}
            occurrence={selectedOccurrence}
            onSubmit={handleRecordIntake}
            onSuccess={() => setSelectedOccurrence(null)}
            onCancel={() => setSelectedOccurrence(null)}
            disabled={loadingState === "submitting"}
            serverError={intakeError}
          />
        ) : null}

        {lowStockProducts.length > 0 ? (
          <div className={`${styles.status} ${styles.statusError}`} role="status">
            <p className={styles.sectionTitle}>低在庫の商品</p>
            <ul>
              {lowStockProducts.map((product) => (
                <li key={product.id}>
                  {product.name}: 残り {product.stock.remainingTotal}
                  {unitLabel(product.defaultUnit)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <section className={styles.card} aria-labelledby="today-schedule-heading">
          <h2 className={styles.sectionTitle} id="today-schedule-heading">
            今日（{todayLocal}）の予定
          </h2>
          {todayOccurrences.length === 0 ? (
            <p className={styles.empty}>今日の予定はありません。</p>
          ) : (
            <div role="list">
              {todayOccurrences.map((occurrence) => {
                const taken = findIntakeForOccurrence(occurrence, intakes);
                return (
                  <div
                    key={occurrence.scheduleId + occurrence.scheduledFor}
                    className={`${styles.scheduleItem} ${taken ? styles.scheduleTaken : ""}`}
                    role="listitem"
                  >
                    <span className={styles.statusSecondary}>{occurrence.timeOfDay ?? "—"}</span>
                    <span>
                      {occurrence.productName} {occurrence.amount}
                      {unitLabel(occurrence.unit)}
                    </span>
                    {taken ? (
                      <span className={`${styles.badge} ${styles.statusSuccess}`}>記録済み</span>
                    ) : (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonSmall}`}
                        onClick={() => handleSelectOccurrence(occurrence)}
                        disabled={loadingState === "submitting"}
                      >
                        記録する
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="recent-intake-heading">
          <h2 className={styles.sectionTitle} id="recent-intake-heading">
            最近の服用
          </h2>
          {intakes.length === 0 ? (
            <p className={styles.empty}>服用履歴がありません。</p>
          ) : (
            <div role="list">
              {intakes.slice(0, 5).map((intake) => (
                <div key={intake.id} className={styles.scheduleItem} role="listitem">
                  <span className={styles.statusSecondary}>
                    {formatDateTimeJa(intake.recordedAt)}
                  </span>
                  <span>
                    {intake.productName} {intake.amount}
                    {unitLabel(intake.unit)}
                  </span>
                  <span>
                    {intake.status === "taken"
                      ? "服用"
                      : intake.status === "skipped"
                        ? "スキップ"
                        : intake.status === "as_needed"
                          ? "必要時"
                          : "取消済み"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className={styles.statusInfo} role="note">
          サプリメントは医療行為の代替ではありません。体調に不安がある場合は医師・薬剤師に相談してください。
        </p>
      </div>
    </main>
  );
}

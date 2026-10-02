"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SupplementIntake } from "../schema";
import { useSupplements } from "../use-supplements";
import { listSupplements } from "../api";
import { buildIntakeCsv, downloadCsv, generateUuid } from "../utils";
import { IntakeList } from "./intake-list";
import { ConflictBanner } from "./conflict-banner";
import { SupplementSubnav } from "./supplement-subnav";
import styles from "./supplements.module.css";

export function HistoryPage() {
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);

  const {
    entries,
    summary,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    loadMore,
    voidIntake,
  } = useSupplements<SupplementIntake>("intake");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const handleVoid = useCallback(
    async (intake: SupplementIntake) => {
      const reason = window.prompt("取消理由（任意）") ?? "";
      if (reason === null) {
        return;
      }
      setFormError(null);
      const request = {
        resource: "void_intake" as const,
        clientMutationId: generateUuid(),
        void: {
          id: intake.id,
          expectedRowVersion: intake.rowVersion,
          reason: reason.trim() || null,
        },
      };
      const ok = await voidIntake(request, { editingIntake: intake, setEditingIntake: undefined });
      if (!ok) {
        setFormError(error);
      }
    },
    [voidIntake, error],
  );

  const handleExportCsv = useCallback(async () => {
    setCsvLoading(true);
    setCsvError(null);
    const all: SupplementIntake[] = [];
    let cursor: string | undefined;
    do {
      const result = await listSupplements({
        resource: "intake",
        order: "desc",
        limit: 500,
        cursor,
      });
      if (!result.ok) {
        setCsvError(result.error.message);
        setCsvLoading(false);
        return;
      }
      all.push(...(result.data.entries as SupplementIntake[]));
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    downloadCsv(
      `supplement-intake-${new Date().toISOString().slice(0, 10)}.csv`,
      buildIntakeCsv(all),
    );
    setCsvLoading(false);
  }, []);

  const takenCount = useMemo(
    () => entries.filter((i) => i.status === "taken" || i.status === "as_needed").length,
    [entries],
  );

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>サプリメント 服用履歴</h1>
        </header>

        <SupplementSubnav current="/supplements/history" />

        {error ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {error}
          </p>
        ) : null}
        {formError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {formError}
          </p>
        ) : null}
        {csvError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {csvError}
          </p>
        ) : null}
        {isLoading && !isSubmitting ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            読み込み中…
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

        {summary ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            週の予定 {summary.weeklyScheduledCount} / 服用 {summary.weeklyTakenCount} / 月の服用{" "}
            {summary.monthlyTakenCount}
            <span className={styles.statusSecondary}>（表示中 {takenCount}件）</span>
          </p>
        ) : null}

        <section className={styles.card} aria-labelledby="intake-list-heading">
          <h2 className={styles.sectionTitle} id="intake-list-heading">
            服用履歴一覧
          </h2>
          <IntakeList intakes={entries} onVoid={handleVoid} disabled={isSubmitting} />
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

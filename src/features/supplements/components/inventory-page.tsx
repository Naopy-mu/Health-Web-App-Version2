"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SupplementLot } from "../schema";
import { useSupplements } from "../use-supplements";
import { generateUuid } from "../utils";
import { LotForm } from "./lot-form";
import { LotList } from "./lot-list";
import { IntakeForm } from "./intake-form";
import { ConflictBanner } from "./conflict-banner";
import { SupplementSubnav } from "./supplement-subnav";
import styles from "./supplements.module.css";

export function InventoryPage() {
  const [editingLot, setEditingLot] = useState<SupplementLot | null>(null);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const lotMutationIdRef = useRef<string | null>(null);

  const {
    entries,
    products,
    activeProducts,
    loadingState,
    error,
    conflict,
    nextCursor,
    isLoadingMore,
    loadMore,
    saveLot,
    removeLot,
    recordIntake,
  } = useSupplements<SupplementLot>("lot");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const getLotMutationId = useCallback(() => {
    if (!lotMutationIdRef.current) {
      lotMutationIdRef.current = generateUuid();
    }
    return lotMutationIdRef.current;
  }, []);

  const clearLotMutationId = useCallback(() => {
    lotMutationIdRef.current = null;
  }, []);

  const handleSaveLot = useCallback(
    async (input: {
      id?: string;
      expectedRowVersion?: number;
      productId: string;
      lotCode: string | null;
      quantity: number;
      remainingQuantity?: number;
      purchasedOn: string | null;
      openedOn: string | null;
      expiresOn: string | null;
      note: string | null;
    }) => {
      const request = {
        resource: "lot" as const,
        clientMutationId: getLotMutationId(),
        lot: input,
      };
      const ok = await saveLot(request, { editingLot, setEditingLot });
      if (ok) {
        setEditingLot(null);
        clearLotMutationId();
      }
      return ok;
    },
    [saveLot, editingLot, getLotMutationId, clearLotMutationId],
  );

  const handleDeleteLot = useCallback(
    async (lot: SupplementLot) => {
      if (
        !window.confirm(
          "この在庫ロットを削除してよろしいですか？服用履歴に使われているロットは削除できません。",
        )
      ) {
        return;
      }
      const request = {
        resource: "lot" as const,
        id: lot.id,
        expectedRowVersion: lot.rowVersion,
      };
      const ok = await removeLot(request, { editingLot, setEditingLot });
      if (ok && editingLot?.id === lot.id) {
        setEditingLot(null);
      }
    },
    [removeLot, editingLot],
  );

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
      const request = {
        resource: "intake" as const,
        clientMutationId: generateUuid(),
        intake: input,
      };
      const ok = await recordIntake(request);
      if (!ok) {
        setIntakeError(error);
      }
      return ok;
    },
    [recordIntake, error],
  );

  const lowStockProducts = useMemo(
    () => activeProducts.filter((p) => p.stock.lowStock),
    [activeProducts],
  );

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>サプリメント 在庫</h1>
        </header>

        <SupplementSubnav current="/supplements/inventory" />

        {error ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {error}
          </p>
        ) : null}
        {intakeError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {intakeError}
          </p>
        ) : null}
        {isLoading && !isSubmitting ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            読み込み中…
          </p>
        ) : null}

        {conflict ? <ConflictBanner ref={conflictRef} conflict={conflict} /> : null}

        {lowStockProducts.length > 0 ? (
          <div className={`${styles.status} ${styles.statusError}`} role="status">
            <p className={styles.sectionTitle}>低在庫の商品</p>
            <ul>
              {lowStockProducts.map((product) => (
                <li key={product.id}>
                  {product.name}: 残り {product.stock.remainingTotal}
                  {product.defaultUnit}（しきい値 {product.lowStockThreshold}）
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <IntakeForm
          products={products}
          lots={entries}
          onSubmit={handleRecordIntake}
          disabled={isSubmitting}
          serverError={intakeError}
        />

        <LotForm
          products={products}
          editingLot={editingLot}
          onSubmit={handleSaveLot}
          onCancel={() => {
            setEditingLot(null);
            clearLotMutationId();
          }}
          disabled={isSubmitting}
          serverError={error}
        />

        <section className={styles.card} aria-labelledby="lot-list-heading">
          <h2 className={styles.sectionTitle} id="lot-list-heading">
            在庫ロット一覧
          </h2>
          <LotList
            lots={entries}
            onEdit={setEditingLot}
            onDelete={handleDeleteLot}
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

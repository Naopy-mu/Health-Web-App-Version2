"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { SupplementLot, SupplementProduct } from "../schema";
import {
  SUPPLEMENT_RECORDABLE_STATUSES,
  SUPPLEMENT_UNITS,
  type SupplementRecordableStatus,
  type SupplementUnit,
} from "../units";
import { planFefoConsumption } from "../units";
import { unitLabel } from "../labels";
import {
  buildAdhocIntakeIdempotencyKey,
  buildScheduledIntakeIdempotencyKey,
  productById,
  toDateTimeLocalValue,
} from "../utils";
import styles from "./supplements.module.css";

export type IntakeFormOccurrence = {
  scheduleId: string;
  scheduledFor: string;
  productId: string;
  amount: number;
  unit: SupplementUnit;
};

type IntakeFormData = {
  productId: string;
  status: SupplementRecordableStatus;
  recordedAt: string;
  amount: string;
  unit: SupplementUnit;
  consumeQuantity: string;
  scheduleId: string;
  scheduledFor: string;
  note: string;
};

function emptyForm(defaultProductId: string): IntakeFormData {
  return {
    productId: defaultProductId,
    status: "taken",
    recordedAt: toDateTimeLocalValue(new Date()),
    amount: "",
    unit: "tablet",
    consumeQuantity: "",
    scheduleId: "",
    scheduledFor: "",
    note: "",
  };
}

type IntakeFormProps = {
  products: SupplementProduct[];
  lots: SupplementLot[];
  occurrence?: IntakeFormOccurrence;
  onSubmit: (input: {
    productId: string;
    idempotencyKey: string;
    recordedAt: string;
    status: SupplementRecordableStatus;
    amount: number;
    unit: SupplementUnit;
    scheduleId: string | null;
    scheduledFor: string | null;
    consumeQuantity: number | undefined;
    note: string | null;
  }) => void;
  onCancel?: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function IntakeForm({
  products,
  lots,
  occurrence,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: IntakeFormProps) {
  const [form, setForm] = useState<IntakeFormData>(() =>
    emptyForm(products.find((p) => p.archivedAt === null)?.id ?? ""),
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof IntakeFormData, string>>>({});

  const productId = useId();
  const statusId = useId();
  const recordedAtId = useId();
  const amountId = useId();
  const unitId = useId();
  const consumeQuantityId = useId();
  const noteId = useId();

  const previousOccurrenceId = useRef<string | null>(null);

  const selectedProduct = productById(products, form.productId);
  const isArchived = selectedProduct?.archivedAt !== null;

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const occurrenceId = occurrence ? `${occurrence.scheduleId}:${occurrence.scheduledFor}` : null;
    if (occurrenceId === previousOccurrenceId.current) {
      return;
    }
    previousOccurrenceId.current = occurrenceId;

    if (occurrence) {
      setForm({
        productId: occurrence.productId,
        status: "taken",
        recordedAt: toDateTimeLocalValue(new Date()),
        amount: String(occurrence.amount),
        unit: occurrence.unit,
        consumeQuantity: "",
        scheduleId: occurrence.scheduleId,
        scheduledFor: occurrence.scheduledFor,
        note: "",
      });
    } else {
      setForm(emptyForm(products.find((p) => p.archivedAt === null)?.id ?? ""));
    }
    setFieldErrors({});
  }, [occurrence, products]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!occurrence && selectedProduct) {
      setForm((prev) => {
        if (prev.productId !== selectedProduct.id) {
          return prev;
        }
        const nextAmount =
          prev.amount === "" && selectedProduct.defaultAmount !== null
            ? String(selectedProduct.defaultAmount)
            : prev.amount;
        const nextUnit =
          prev.productId === selectedProduct.id ? prev.unit : selectedProduct.defaultUnit;
        return { ...prev, amount: nextAmount, unit: nextUnit };
      });
    }
  }, [selectedProduct, occurrence]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChange = (field: keyof IntakeFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const productLots = useMemo(
    () => lots.filter((lot) => lot.productId === form.productId),
    [lots, form.productId],
  );

  const consumeQuantityValue = useMemo(() => {
    if (form.status === "skipped") {
      return 0;
    }
    const explicit = form.consumeQuantity.trim();
    if (explicit !== "") {
      const num = Number(explicit);
      if (!Number.isNaN(num)) {
        return num;
      }
    }
    if (selectedProduct && form.unit === selectedProduct.defaultUnit) {
      return Number(form.amount);
    }
    return null;
  }, [form.status, form.consumeQuantity, form.unit, form.amount, selectedProduct]);

  const fefoPlan = useMemo(() => {
    if (consumeQuantityValue === null || Number.isNaN(consumeQuantityValue)) {
      return null;
    }
    return planFefoConsumption(productLots, consumeQuantityValue);
  }, [consumeQuantityValue, productLots]);

  const validate = (): boolean => {
    const errors: Partial<Record<keyof IntakeFormData, string>> = {};

    if (!form.productId) {
      errors.productId = "商品を選んでください。";
    } else if (isArchived) {
      errors.productId = "アーカイブ済みの商品は服用記録できません。";
    }

    if (!form.recordedAt) {
      errors.recordedAt = "記録日時を入力してください。";
    }

    const amount = Number(form.amount);
    if (form.amount === "" || Number.isNaN(amount) || amount <= 0) {
      errors.amount = "量は0より大きい数値で入力してください。";
    }

    if (!SUPPLEMENT_UNITS.includes(form.unit)) {
      errors.unit = "単位を選んでください。";
    }

    if (
      form.consumeQuantity.trim() !== "" &&
      (Number.isNaN(Number(form.consumeQuantity)) || Number(form.consumeQuantity) < 0)
    ) {
      errors.consumeQuantity = "在庫消費量は0以上の数値で入力してください。";
    }

    if (
      selectedProduct &&
      form.unit !== selectedProduct.defaultUnit &&
      form.consumeQuantity.trim() === "" &&
      form.status !== "skipped"
    ) {
      errors.consumeQuantity = `単位が商品の既定単位（${unitLabel(selectedProduct.defaultUnit)}）と異なるため、在庫消費量を明示してください。`;
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate() || !selectedProduct) {
      return;
    }

    const recordedAt = new Date(form.recordedAt).toISOString();
    let idempotencyKey: string;
    if (form.scheduleId && form.scheduledFor) {
      idempotencyKey = buildScheduledIntakeIdempotencyKey(form.scheduleId, form.scheduledFor);
    } else {
      idempotencyKey = buildAdhocIntakeIdempotencyKey(form.productId, recordedAt);
    }

    let consumeQuantity: number | undefined;
    if (form.status === "skipped") {
      consumeQuantity = 0;
    } else if (form.consumeQuantity.trim() !== "") {
      consumeQuantity = Number(form.consumeQuantity);
    }

    onSubmit({
      productId: form.productId,
      idempotencyKey,
      recordedAt,
      status: form.status,
      amount: Number(form.amount),
      unit: form.unit,
      scheduleId: form.scheduleId || null,
      scheduledFor: form.scheduledFor || null,
      consumeQuantity,
      note: form.note.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={occurrence ? "record-intake-heading" : "new-intake-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={occurrence ? "record-intake-heading" : "new-intake-heading"}
      >
        {occurrence ? "服用を記録" : "新規服用記録"}
      </h2>
      {serverError ? (
        <p className={`${styles.status} ${styles.statusError}`} role="alert">
          {serverError}
        </p>
      ) : null}
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={productId}>
              商品
            </label>
            <select
              id={productId}
              className={styles.select}
              value={form.productId}
              onChange={(event) => handleChange("productId", event.target.value)}
              disabled={disabled || occurrence !== undefined}
              aria-invalid={Boolean(fieldErrors.productId)}
              aria-describedby={fieldErrors.productId ? `${productId}-error` : undefined}
            >
              {products.length === 0 ? <option value="">商品がありません</option> : null}
              {products.map((product) => (
                <option key={product.id} value={product.id} disabled={product.archivedAt !== null}>
                  {product.name}
                  {product.archivedAt !== null ? "（アーカイブ済み）" : ""}
                </option>
              ))}
            </select>
            {fieldErrors.productId ? (
              <p className={styles.fieldError} id={`${productId}-error`}>
                {fieldErrors.productId}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={statusId}>
              状態
            </label>
            <select
              id={statusId}
              className={styles.select}
              value={form.status}
              onChange={(event) =>
                handleChange("status", event.target.value as SupplementRecordableStatus)
              }
              disabled={disabled}
            >
              {SUPPLEMENT_RECORDABLE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status === "taken" ? "服用" : status === "skipped" ? "スキップ" : "必要時"}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={recordedAtId}>
              記録日時
            </label>
            <input
              id={recordedAtId}
              className={styles.input}
              type="datetime-local"
              value={form.recordedAt}
              onChange={(event) => handleChange("recordedAt", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.recordedAt)}
              aria-describedby={fieldErrors.recordedAt ? `${recordedAtId}-error` : undefined}
            />
            {fieldErrors.recordedAt ? (
              <p className={styles.fieldError} id={`${recordedAtId}-error`}>
                {fieldErrors.recordedAt}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={amountId}>
              量
            </label>
            <input
              id={amountId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.amount}
              onChange={(event) => handleChange("amount", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.amount)}
              aria-describedby={fieldErrors.amount ? `${amountId}-error` : undefined}
            />
            {fieldErrors.amount ? (
              <p className={styles.fieldError} id={`${amountId}-error`}>
                {fieldErrors.amount}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={unitId}>
              単位
            </label>
            <select
              id={unitId}
              className={styles.select}
              value={form.unit}
              onChange={(event) => handleChange("unit", event.target.value as SupplementUnit)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.unit)}
              aria-describedby={fieldErrors.unit ? `${unitId}-error` : undefined}
            >
              {SUPPLEMENT_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
            {fieldErrors.unit ? (
              <p className={styles.fieldError} id={`${unitId}-error`}>
                {fieldErrors.unit}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={consumeQuantityId}>
              在庫消費量（空欄で自動）
            </label>
            <input
              id={consumeQuantityId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.consumeQuantity}
              placeholder={selectedProduct ? unitLabel(selectedProduct.defaultUnit) : undefined}
              onChange={(event) => handleChange("consumeQuantity", event.target.value)}
              disabled={disabled || form.status === "skipped"}
              aria-invalid={Boolean(fieldErrors.consumeQuantity)}
              aria-describedby={
                fieldErrors.consumeQuantity ? `${consumeQuantityId}-error` : undefined
              }
            />
            {fieldErrors.consumeQuantity ? (
              <p className={styles.fieldError} id={`${consumeQuantityId}-error`}>
                {fieldErrors.consumeQuantity}
              </p>
            ) : null}
          </div>
        </div>

        {selectedProduct ? (
          <div className={styles.field}>
            <span className={styles.statusSecondary}>
              商品の既定単位: {unitLabel(selectedProduct.defaultUnit)} / 在庫合計:{" "}
              {selectedProduct.stock.remainingTotal}
              {unitLabel(selectedProduct.defaultUnit)}
            </span>
          </div>
        ) : null}

        {fefoPlan ? (
          <div
            className={fefoPlan.shortfall > 0 ? styles.fefoShortfall : styles.fefoPreview}
            role="status"
          >
            <p className={styles.sectionTitle}>
              {fefoPlan.shortfall > 0 ? "在庫が不足しています" : "FEFO 消費見積もり"}
            </p>
            {fefoPlan.shortfall > 0 ? (
              <p>
                あと {fefoPlan.shortfall}
                {selectedProduct ? unitLabel(selectedProduct.defaultUnit) : ""} 必要です。
                在庫を追加するか、消費量を見直してください。
              </p>
            ) : (
              <ul>
                {fefoPlan.steps.map((step) => {
                  const lot = productLots.find((l) => l.id === step.lotId);
                  return (
                    <li key={step.lotId}>
                      {lot?.lotCode ?? "無名ロット"}: {step.quantity}
                      {selectedProduct ? unitLabel(selectedProduct.defaultUnit) : ""}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={noteId}>
            メモ（任意）
          </label>
          <textarea
            id={noteId}
            className={styles.textarea}
            maxLength={500}
            value={form.note}
            onChange={(event) => handleChange("note", event.target.value)}
            disabled={disabled}
          />
        </div>

        <div className={styles.buttonGroup}>
          <button className={styles.button} type="submit" disabled={disabled}>
            {disabled ? "送信中…" : "記録する"}
          </button>
          {onCancel ? (
            <button
              className={`${styles.button} ${styles.buttonSecondary}`}
              type="button"
              onClick={onCancel}
              disabled={disabled}
            >
              キャンセル
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

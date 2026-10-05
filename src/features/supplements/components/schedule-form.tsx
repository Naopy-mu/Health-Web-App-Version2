"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { SupplementProduct, SupplementSchedule } from "../schema";
import {
  SUPPLEMENT_MEAL_RELATIONS,
  SUPPLEMENT_SCHEDULE_KINDS,
  SUPPLEMENT_UNITS,
  type SupplementMealRelation,
  type SupplementScheduleKind,
  type SupplementUnit,
} from "../units";
import { mealRelationLabel, scheduleKindLabel, unitLabel } from "../labels";
import { DEFAULT_TIMEZONE } from "../schema";
import { toDateInputValue } from "../utils";
import styles from "./supplements.module.css";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

type ScheduleFormData = {
  productId: string;
  scheduleKind: SupplementScheduleKind;
  timeOfDay: string;
  weekdays: number[];
  startDate: string;
  endDate: string;
  amount: string;
  unit: SupplementUnit;
  mealRelation: SupplementMealRelation;
  note: string;
};

function emptyForm(defaultProductId: string): ScheduleFormData {
  return {
    productId: defaultProductId,
    scheduleKind: "daily",
    timeOfDay: "08:00",
    weekdays: [],
    startDate: toDateInputValue(new Date()),
    endDate: "",
    amount: "",
    unit: "tablet",
    mealRelation: "unspecified",
    note: "",
  };
}

function entryToForm(entry: SupplementSchedule): ScheduleFormData {
  return {
    productId: entry.productId,
    scheduleKind: entry.scheduleKind,
    timeOfDay: entry.timeOfDay ?? "08:00",
    weekdays: entry.weekdays ?? [],
    startDate: entry.startDate,
    endDate: entry.endDate ?? "",
    amount: String(entry.amount),
    unit: entry.unit,
    mealRelation: entry.mealRelation,
    note: entry.note ?? "",
  };
}

type ScheduleFormProps = {
  products: SupplementProduct[];
  editingSchedule: SupplementSchedule | null;
  onSubmit: (input: {
    id?: string;
    expectedRowVersion?: number;
    productId: string;
    scheduleKind: SupplementScheduleKind;
    timeOfDay: string | null;
    timezone: string;
    weekdays: number[] | null;
    startDate: string;
    endDate: string | null;
    amount: number;
    unit: SupplementUnit;
    mealRelation: SupplementMealRelation;
    note: string | null;
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function ScheduleForm({
  products,
  editingSchedule,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: ScheduleFormProps) {
  const [form, setForm] = useState<ScheduleFormData>(() =>
    emptyForm(products.find((p) => p.archivedAt === null)?.id ?? ""),
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ScheduleFormData, string>>>(
    {},
  );

  const productId = useId();
  const kindId = useId();
  const timeId = useId();
  const startDateId = useId();
  const endDateId = useId();
  const amountId = useId();
  const unitId = useId();
  const mealRelationId = useId();
  const noteId = useId();

  const previousEditingId = useRef<string | null>(null);

  const selectedProduct = products.find((p) => p.id === form.productId);
  const isArchived = selectedProduct?.archivedAt !== null;

  useEffect(() => {
    const editingId = editingSchedule?.id ?? null;
    if (editingId === previousEditingId.current) {
      return;
    }
    previousEditingId.current = editingId;
    const defaultProductId =
      products.find((p) => p.archivedAt === null)?.id ?? products[0]?.id ?? "";
    setForm(editingSchedule ? entryToForm(editingSchedule) : emptyForm(defaultProductId));
    setFieldErrors({});
  }, [editingSchedule, products]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (form.productId || products.length === 0) {
      return;
    }
    const firstActive = products.find((p) => p.archivedAt === null);
    setForm((prev) => ({
      ...prev,
      productId: firstActive?.id ?? products[0]?.id ?? "",
      unit: firstActive?.defaultUnit ?? prev.unit,
    }));
  }, [products, form.productId]);

  useEffect(() => {
    if (editingSchedule || !selectedProduct) {
      return;
    }
    setForm((prev) => ({
      ...prev,
      unit: selectedProduct.defaultUnit,
      amount:
        prev.amount === "" && selectedProduct.defaultAmount !== null
          ? String(selectedProduct.defaultAmount)
          : prev.amount,
    }));
  }, [selectedProduct, editingSchedule]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChange = (field: keyof ScheduleFormData, value: string | number[] | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const toggleWeekday = (day: number) => {
    setForm((prev) => {
      const next = prev.weekdays.includes(day)
        ? prev.weekdays.filter((d) => d !== day)
        : [...prev.weekdays, day];
      return { ...prev, weekdays: next.sort((a, b) => a - b) };
    });
    setFieldErrors((prev) => ({ ...prev, weekdays: undefined }));
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof ScheduleFormData, string>> = {};

    if (!form.productId) {
      errors.productId = "商品を選んでください。";
    } else if (isArchived) {
      errors.productId = "アーカイブ済みの商品には予定を登録できません。";
    }

    if (!form.startDate) {
      errors.startDate = "開始日を入力してください。";
    }

    if (form.endDate && form.endDate < form.startDate) {
      errors.endDate = "終了日は開始日以降にしてください。";
    }

    if (form.scheduleKind === "once" && form.endDate && form.endDate !== form.startDate) {
      errors.endDate = "単発の予定では終了日を開始日と同じ日にしてください。";
    }

    if (form.scheduleKind !== "as_needed" && !form.timeOfDay) {
      errors.timeOfDay = "時刻を入力してください。";
    }

    if (form.scheduleKind === "weekly" && form.weekdays.length === 0) {
      errors.weekdays = "対象曜日を1つ以上選んでください。";
    }

    const amount = Number(form.amount);
    if (form.amount === "" || Number.isNaN(amount) || amount <= 0) {
      errors.amount = "量は0より大きい数値で入力してください。";
    }

    if (!SUPPLEMENT_UNITS.includes(form.unit)) {
      errors.unit = "単位を選んでください。";
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    onSubmit({
      ...(editingSchedule
        ? { id: editingSchedule.id, expectedRowVersion: editingSchedule.rowVersion }
        : {}),
      productId: form.productId,
      scheduleKind: form.scheduleKind,
      timeOfDay: form.scheduleKind === "as_needed" ? null : form.timeOfDay,
      timezone: DEFAULT_TIMEZONE,
      weekdays: form.scheduleKind === "weekly" ? form.weekdays : null,
      startDate: form.startDate,
      endDate: form.endDate || null,
      amount: Number(form.amount),
      unit: form.unit,
      mealRelation: form.mealRelation,
      note: form.note.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingSchedule ? "edit-schedule-heading" : "new-schedule-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={editingSchedule ? "edit-schedule-heading" : "new-schedule-heading"}
      >
        {editingSchedule ? "摂取予定を編集" : "新規摂取予定"}
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
              disabled={disabled}
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
            <label className={styles.label} htmlFor={kindId}>
              種別
            </label>
            <select
              id={kindId}
              className={styles.select}
              value={form.scheduleKind}
              onChange={(event) =>
                handleChange("scheduleKind", event.target.value as SupplementScheduleKind)
              }
              disabled={disabled}
            >
              {SUPPLEMENT_SCHEDULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {scheduleKindLabel(kind)}
                </option>
              ))}
            </select>
          </div>

          {form.scheduleKind !== "as_needed" ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={timeId}>
                時刻
              </label>
              <input
                id={timeId}
                className={styles.input}
                type="time"
                value={form.timeOfDay}
                onChange={(event) => handleChange("timeOfDay", event.target.value)}
                disabled={disabled}
                aria-invalid={Boolean(fieldErrors.timeOfDay)}
                aria-describedby={fieldErrors.timeOfDay ? `${timeId}-error` : undefined}
              />
              {fieldErrors.timeOfDay ? (
                <p className={styles.fieldError} id={`${timeId}-error`}>
                  {fieldErrors.timeOfDay}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {form.scheduleKind === "weekly" ? (
          <div className={styles.field}>
            <span className={styles.label}>対象曜日</span>
            <div className={styles.buttonGroup}>
              {WEEKDAY_LABELS.map((label, index) => (
                <button
                  key={index}
                  type="button"
                  className={`${styles.button} ${form.weekdays.includes(index) ? "" : styles.buttonSecondary}`}
                  aria-pressed={form.weekdays.includes(index)}
                  onClick={() => toggleWeekday(index)}
                  disabled={disabled}
                >
                  {label}
                </button>
              ))}
            </div>
            {fieldErrors.weekdays ? (
              <p className={styles.fieldError}>{fieldErrors.weekdays}</p>
            ) : null}
          </div>
        ) : null}

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={startDateId}>
              開始日
            </label>
            <input
              id={startDateId}
              className={styles.input}
              type="date"
              value={form.startDate}
              onChange={(event) => handleChange("startDate", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.startDate)}
              aria-describedby={fieldErrors.startDate ? `${startDateId}-error` : undefined}
            />
            {fieldErrors.startDate ? (
              <p className={styles.fieldError} id={`${startDateId}-error`}>
                {fieldErrors.startDate}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={endDateId}>
              終了日（任意）
            </label>
            <input
              id={endDateId}
              className={styles.input}
              type="date"
              value={form.endDate}
              onChange={(event) => handleChange("endDate", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.endDate)}
              aria-describedby={fieldErrors.endDate ? `${endDateId}-error` : undefined}
            />
            {fieldErrors.endDate ? (
              <p className={styles.fieldError} id={`${endDateId}-error`}>
                {fieldErrors.endDate}
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
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={mealRelationId}>
            食事との関係
          </label>
          <select
            id={mealRelationId}
            className={styles.select}
            value={form.mealRelation}
            onChange={(event) =>
              handleChange("mealRelation", event.target.value as SupplementMealRelation)
            }
            disabled={disabled}
          >
            {SUPPLEMENT_MEAL_RELATIONS.map((relation) => (
              <option key={relation} value={relation}>
                {mealRelationLabel(relation)}
              </option>
            ))}
          </select>
        </div>

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
            {disabled ? "送信中…" : editingSchedule ? "更新する" : "登録する"}
          </button>
          {editingSchedule ? (
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

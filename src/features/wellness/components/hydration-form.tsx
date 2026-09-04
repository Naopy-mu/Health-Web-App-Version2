"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { BeverageType, HydrationEntry } from "../schema";
import { HYDRATION_UNITS, type HydrationUnit } from "../units";
import { beverageTypeById, parseDateTimeLocal, toDateTimeLocalValue } from "../utils";
import styles from "../wellness.module.css";

type HydrationFormData = {
  beverageTypeId: string;
  recordedAt: string;
  amount: string;
  unit: HydrationUnit;
  containsCaffeine: boolean;
  containsAlcohol: boolean;
  note: string;
};

function emptyForm(defaultTypeId: string): HydrationFormData {
  return {
    beverageTypeId: defaultTypeId,
    recordedAt: toDateTimeLocalValue(new Date()),
    amount: "",
    unit: "ml",
    containsCaffeine: false,
    containsAlcohol: false,
    note: "",
  };
}

function entryToForm(entry: HydrationEntry): HydrationFormData {
  return {
    beverageTypeId: entry.beverageTypeId,
    recordedAt: toDateTimeLocalValue(new Date(entry.recordedAt)),
    amount: String(entry.amount),
    unit: entry.unit,
    containsCaffeine: entry.containsCaffeine,
    containsAlcohol: entry.containsAlcohol,
    note: entry.note ?? "",
  };
}

type HydrationFormProps = {
  beverageTypes: BeverageType[];
  editingEntry: HydrationEntry | null;
  onSubmit: (input: {
    id?: string;
    expectedRowVersion?: number;
    beverageTypeId: string;
    recordedAt: string;
    amount: number;
    unit: HydrationUnit;
    containsCaffeine: boolean;
    containsAlcohol: boolean;
    note: string | null;
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function HydrationForm({
  beverageTypes,
  editingEntry,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: HydrationFormProps) {
  const [form, setForm] = useState<HydrationFormData>(() => emptyForm(beverageTypes[0]?.id ?? ""));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof HydrationFormData, string>>>(
    {},
  );

  const typeId = useId();
  const recordedAtId = useId();
  const amountId = useId();
  const unitId = useId();
  const caffeineId = useId();
  const alcoholId = useId();
  const noteId = useId();

  const previousEditingId = useRef<string | null>(null);
  const previousDefaultTypeId = useRef<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const editingId = editingEntry?.id ?? null;
    const defaultTypeId = beverageTypes[0]?.id ?? null;
    const editingIdChanged = editingId !== previousEditingId.current;
    const defaultTypeChanged = defaultTypeId !== previousDefaultTypeId.current;
    if (!editingIdChanged && !defaultTypeChanged) {
      return;
    }
    previousEditingId.current = editingId;
    previousDefaultTypeId.current = defaultTypeId;

    if (editingEntry) {
      setForm(entryToForm(editingEntry));
    } else if (beverageTypes.length === 0) {
      return;
    } else {
      setForm((prev) => {
        if (prev.beverageTypeId && prev.amount) {
          return prev;
        }
        return emptyForm(beverageTypes[0].id);
      });
    }
    setFieldErrors({});
  }, [editingEntry, beverageTypes]);

  const selectedType = beverageTypeById(beverageTypes, form.beverageTypeId);

  useEffect(() => {
    if (selectedType && !editingEntry) {
      setForm((prev) => ({
        ...prev,
        containsCaffeine: selectedType.containsCaffeine,
        containsAlcohol: selectedType.containsAlcohol,
      }));
    }
  }, [selectedType, editingEntry]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChange = (field: keyof HydrationFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof HydrationFormData, string>> = {};
    if (!form.beverageTypeId) {
      errors.beverageTypeId = "飲み物種別を選んでください。";
    }
    if (!form.recordedAt) {
      errors.recordedAt = "日時を入力してください。";
    }
    const amount = Number(form.amount);
    if (form.amount === "" || Number.isNaN(amount) || amount <= 0 || amount > 10000) {
      errors.amount = "量は0より大きく10,000以下で入力してください。";
    }
    if (!HYDRATION_UNITS.includes(form.unit)) {
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
      ...(editingEntry ? { id: editingEntry.id, expectedRowVersion: editingEntry.rowVersion } : {}),
      beverageTypeId: form.beverageTypeId,
      recordedAt: parseDateTimeLocal(form.recordedAt).toISOString(),
      amount: Number(form.amount),
      unit: form.unit,
      containsCaffeine: form.containsCaffeine,
      containsAlcohol: form.containsAlcohol,
      note: form.note.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingEntry ? "edit-hydration-heading" : "new-hydration-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={editingEntry ? "edit-hydration-heading" : "new-hydration-heading"}
      >
        {editingEntry ? "水分記録を編集" : "新規水分記録"}
      </h2>
      {serverError ? (
        <p className={`${styles.status} ${styles.statusError}`} role="alert">
          {serverError}
        </p>
      ) : null}
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={typeId}>
              飲み物
            </label>
            <select
              id={typeId}
              className={styles.select}
              value={form.beverageTypeId}
              onChange={(event) => handleChange("beverageTypeId", event.target.value)}
              disabled={disabled || beverageTypes.length === 0}
              aria-invalid={Boolean(fieldErrors.beverageTypeId)}
              aria-describedby={fieldErrors.beverageTypeId ? `${typeId}-error` : undefined}
            >
              {beverageTypes.length === 0 ? <option value="">種別がありません</option> : null}
              {beverageTypes
                .filter((type) => type.archivedAt === null)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.displayName}
                  </option>
                ))}
            </select>
            {fieldErrors.beverageTypeId ? (
              <p className={styles.fieldError} id={`${typeId}-error`}>
                {fieldErrors.beverageTypeId}
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
              onChange={(event) => handleChange("unit", event.target.value as HydrationUnit)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.unit)}
              aria-describedby={fieldErrors.unit ? `${unitId}-error` : undefined}
            >
              {HYDRATION_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
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
            <label className={styles.label} htmlFor={recordedAtId}>
              日時
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
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={caffeineId}>
              <input
                id={caffeineId}
                className={styles.checkbox}
                type="checkbox"
                checked={form.containsCaffeine}
                onChange={(event) => handleChange("containsCaffeine", event.target.checked)}
                disabled={disabled}
              />{" "}
              カフェインを含む
            </label>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={alcoholId}>
              <input
                id={alcoholId}
                className={styles.checkbox}
                type="checkbox"
                checked={form.containsAlcohol}
                onChange={(event) => handleChange("containsAlcohol", event.target.checked)}
                disabled={disabled}
              />{" "}
              アルコールを含む
            </label>
          </div>
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
            {disabled ? "送信中…" : editingEntry ? "更新する" : "記録する"}
          </button>
          {editingEntry ? (
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

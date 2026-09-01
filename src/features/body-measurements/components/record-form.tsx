"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { Measurement, MeasurementType } from "../schema";
import { isUnitAllowedFor, type MeasurementUnit, UNITS_BY_CONSTRAINT } from "../units";
import { parseDateTimeLocal, toDateTimeLocalValue } from "../utils";
import styles from "../measurements.module.css";

type MeasurementFormData = {
  typeId: string;
  value: string;
  unit: string;
  measuredAt: string;
  note: string;
  measurementCondition: string;
  bodySite: string;
  photoReference: string;
};

function emptyForm(): MeasurementFormData {
  return {
    typeId: "",
    value: "",
    unit: "",
    measuredAt: toDateTimeLocalValue(new Date()),
    note: "",
    measurementCondition: "",
    bodySite: "",
    photoReference: "",
  };
}

function measurementToFormData(measurement: Measurement): MeasurementFormData {
  return {
    typeId: measurement.typeId,
    value: String(measurement.value),
    unit: measurement.unit,
    measuredAt: toDateTimeLocalValue(new Date(measurement.measuredAt)),
    note: measurement.note ?? "",
    measurementCondition: measurement.measurementCondition ?? "",
    bodySite: measurement.bodySite ?? "",
    photoReference: measurement.photoReference ?? "",
  };
}

type RecordFormProps = {
  activeTypes: MeasurementType[];
  editingMeasurement: Measurement | null;
  onSubmit: (input: {
    id?: string;
    expectedRowVersion?: number;
    typeId: string;
    measuredAt: string;
    value: number;
    unit: MeasurementUnit;
    note: string | null;
    measurementCondition: string | null;
    bodySite: string | null;
    photoReference: string | null;
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function RecordForm({
  activeTypes,
  editingMeasurement,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: RecordFormProps) {
  const [form, setForm] = useState<MeasurementFormData>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof MeasurementFormData, string>>
  >({});
  const typeId = useId();
  const valueId = useId();
  const unitId = useId();
  const measuredAtId = useId();
  const noteId = useId();
  const conditionId = useId();
  const bodySiteId = useId();
  const photoId = useId();

  const selectedType = useMemo(
    () => activeTypes.find((type) => type.id === form.typeId) ?? activeTypes[0],
    [activeTypes, form.typeId],
  );

  const previousEditingId = useRef<string | null>(null);
  const previousActiveTypeId = useRef<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const editingId = editingMeasurement?.id ?? null;
    const activeTypeId = activeTypes[0]?.id ?? null;
    // rowVersion / updatedAt のみが変わった場合（409後の最新化）は
    // 入力中の内容を保持し、フォームをリセットしない（S1）。
    const editingIdChanged = editingId !== previousEditingId.current;
    const activeTypeChanged = activeTypeId !== previousActiveTypeId.current;
    if (!editingIdChanged && !activeTypeChanged) {
      return;
    }
    previousEditingId.current = editingId;
    previousActiveTypeId.current = activeTypeId;

    if (editingMeasurement) {
      setForm(measurementToFormData(editingMeasurement));
    } else {
      setForm((prev) => {
        if (prev.typeId && prev.unit) {
          // 利用者が既に入力を始めている場合は値を保持する（S1）。
          return prev;
        }
        const initial = emptyForm();
        if (activeTypes[0]) {
          initial.typeId = activeTypes[0].id;
          initial.unit = activeTypes[0].defaultUnit;
        }
        return initial;
      });
    }
    setFieldErrors({});
  }, [editingMeasurement, activeTypes]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 種別変更時に単位が制約に合わなければ既定単位に戻す
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (
      selectedType &&
      form.unit &&
      !isUnitAllowedFor(selectedType.unitConstraint, form.unit as never)
    ) {
      setForm((prev) => ({ ...prev, unit: selectedType.defaultUnit }));
    }
  }, [selectedType, form.unit]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const allowedUnits = useMemo(
    () => (selectedType ? [...UNITS_BY_CONSTRAINT[selectedType.unitConstraint]] : []),
    [selectedType],
  );

  const handleChange = (field: keyof MeasurementFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof MeasurementFormData, string>> = {};
    if (!form.typeId) {
      errors.typeId = "測定種別を選択してください。";
    }
    const numericValue = Number(form.value);
    if (form.value === "" || Number.isNaN(numericValue)) {
      errors.value = "値を数値で入力してください。";
    } else if (numericValue <= 0 || numericValue > 1000) {
      errors.value = "値は0より大きく1000以下で入力してください。";
    }
    if (!form.unit) {
      errors.unit = "単位を選択してください。";
    }
    if (!form.measuredAt) {
      errors.measuredAt = "日時を入力してください。";
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate() || !selectedType) {
      return;
    }
    onSubmit({
      ...(editingMeasurement
        ? { id: editingMeasurement.id, expectedRowVersion: editingMeasurement.rowVersion }
        : {}),
      typeId: form.typeId,
      measuredAt: parseDateTimeLocal(form.measuredAt).toISOString(),
      value: Number(form.value),
      unit: form.unit as MeasurementUnit,
      note: form.note.trim() || null,
      measurementCondition: form.measurementCondition.trim() || null,
      bodySite: form.bodySite.trim() || null,
      photoReference: form.photoReference.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingMeasurement ? "edit-record-heading" : "new-record-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={editingMeasurement ? "edit-record-heading" : "new-record-heading"}
      >
        {editingMeasurement ? "記録を編集" : "新規記録"}
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
              測定種別
            </label>
            <select
              id={typeId}
              className={styles.select}
              value={form.typeId}
              onChange={(event) => handleChange("typeId", event.target.value)}
              disabled={disabled || activeTypes.length === 0}
              aria-invalid={Boolean(fieldErrors.typeId)}
              aria-describedby={fieldErrors.typeId ? `${typeId}-error` : undefined}
            >
              {activeTypes.length === 0 ? <option value="">種別がありません</option> : null}
              {activeTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.displayName}
                </option>
              ))}
            </select>
            {fieldErrors.typeId ? (
              <p className={styles.fieldError} id={`${typeId}-error`}>
                {fieldErrors.typeId}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={valueId}>
              値
            </label>
            <input
              id={valueId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.value}
              onChange={(event) => handleChange("value", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.value)}
              aria-describedby={fieldErrors.value ? `${valueId}-error` : undefined}
            />
            {fieldErrors.value ? (
              <p className={styles.fieldError} id={`${valueId}-error`}>
                {fieldErrors.value}
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
              onChange={(event) => handleChange("unit", event.target.value)}
              disabled={disabled || !selectedType}
              aria-invalid={Boolean(fieldErrors.unit)}
              aria-describedby={fieldErrors.unit ? `${unitId}-error` : undefined}
            >
              {allowedUnits.map((unit) => (
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
            <label className={styles.label} htmlFor={measuredAtId}>
              日時
            </label>
            <input
              id={measuredAtId}
              className={styles.input}
              type="datetime-local"
              value={form.measuredAt}
              onChange={(event) => handleChange("measuredAt", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.measuredAt)}
              aria-describedby={fieldErrors.measuredAt ? `${measuredAtId}-error` : undefined}
            />
            {fieldErrors.measuredAt ? (
              <p className={styles.fieldError} id={`${measuredAtId}-error`}>
                {fieldErrors.measuredAt}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={conditionId}>
              測定条件
            </label>
            <input
              id={conditionId}
              className={styles.input}
              type="text"
              maxLength={200}
              value={form.measurementCondition}
              onChange={(event) => handleChange("measurementCondition", event.target.value)}
              disabled={disabled}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={bodySiteId}>
              測定部位
            </label>
            <input
              id={bodySiteId}
              className={styles.input}
              type="text"
              maxLength={100}
              value={form.bodySite}
              onChange={(event) => handleChange("bodySite", event.target.value)}
              disabled={disabled}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={photoId}>
            写真参照
          </label>
          <input
            id={photoId}
            className={styles.input}
            type="text"
            maxLength={2048}
            placeholder="https://... または storage://health-images/<uuid>/..."
            value={form.photoReference}
            onChange={(event) => handleChange("photoReference", event.target.value)}
            disabled={disabled}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={noteId}>
            メモ
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
            {disabled ? "送信中…" : editingMeasurement ? "更新する" : "記録する"}
          </button>
          {editingMeasurement ? (
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

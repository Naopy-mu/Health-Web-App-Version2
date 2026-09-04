"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { ConditionEntry, SymptomType } from "../schema";
import { parseDateTimeLocal, toDateTimeLocalValue } from "../utils";
import styles from "../wellness.module.css";

type ConditionFormData = {
  recordedAt: string;
  timezone: string;
  overallScore: string;
  fatigueScore: string;
  energyScore: string;
  stressScore: string;
  painScore: string;
  moodScore: string;
  bodyTemperatureC: string;
  freeTextSymptoms: string;
  note: string;
};

const SCORE_FIELDS = [
  { key: "overallScore", label: "総合" },
  { key: "fatigueScore", label: "疲労" },
  { key: "energyScore", label: "活力" },
  { key: "stressScore", label: "ストレス" },
  { key: "painScore", label: "痛み" },
  { key: "moodScore", label: "気分" },
] as const;

function emptyForm(): ConditionFormData {
  return {
    recordedAt: toDateTimeLocalValue(new Date()),
    timezone: "Asia/Tokyo",
    overallScore: "",
    fatigueScore: "",
    energyScore: "",
    stressScore: "",
    painScore: "",
    moodScore: "",
    bodyTemperatureC: "",
    freeTextSymptoms: "",
    note: "",
  };
}

function entryToForm(entry: ConditionEntry): ConditionFormData {
  return {
    recordedAt: toDateTimeLocalValue(new Date(entry.recordedAt)),
    timezone: entry.timezone,
    overallScore: entry.overallScore !== null ? String(entry.overallScore) : "",
    fatigueScore: entry.fatigueScore !== null ? String(entry.fatigueScore) : "",
    energyScore: entry.energyScore !== null ? String(entry.energyScore) : "",
    stressScore: entry.stressScore !== null ? String(entry.stressScore) : "",
    painScore: entry.painScore !== null ? String(entry.painScore) : "",
    moodScore: entry.moodScore !== null ? String(entry.moodScore) : "",
    bodyTemperatureC: entry.bodyTemperatureC !== null ? String(entry.bodyTemperatureC) : "",
    freeTextSymptoms: entry.freeTextSymptoms.join(", "),
    note: entry.note ?? "",
  };
}

type ConditionFormProps = {
  symptomTypes: SymptomType[];
  editingEntry: ConditionEntry | null;
  onSubmit: (input: {
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
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function ConditionForm({
  symptomTypes,
  editingEntry,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: ConditionFormProps) {
  const [form, setForm] = useState<ConditionFormData>(emptyForm);
  const [selectedSymptoms, setSelectedSymptoms] = useState<
    Record<string, { severity: string; note: string }>
  >({});
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ConditionFormData, string>>>(
    {},
  );

  const recordedAtId = useId();
  const timezoneId = useId();
  const temperatureId = useId();
  const freeTextId = useId();
  const noteId = useId();

  const previousEditingId = useRef<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const editingId = editingEntry?.id ?? null;
    if (editingId === previousEditingId.current) {
      return;
    }
    previousEditingId.current = editingId;

    if (editingEntry) {
      setForm(entryToForm(editingEntry));
      const next: Record<string, { severity: string; note: string }> = {};
      for (const symptom of editingEntry.symptoms) {
        next[symptom.symptomTypeId] = {
          severity: symptom.severity !== null ? String(symptom.severity) : "",
          note: symptom.note ?? "",
        };
      }
      setSelectedSymptoms(next);
    } else {
      setForm(emptyForm());
      setSelectedSymptoms({});
    }
    setFieldErrors({});
  }, [editingEntry]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChange = (field: keyof ConditionFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const toggleSymptom = (typeId: string) => {
    setSelectedSymptoms((prev) => {
      const next = { ...prev };
      if (next[typeId]) {
        delete next[typeId];
      } else {
        next[typeId] = { severity: "", note: "" };
      }
      return next;
    });
  };

  const updateSymptom = (typeId: string, field: "severity" | "note", value: string) => {
    setSelectedSymptoms((prev) => ({
      ...prev,
      [typeId]: { ...prev[typeId], [field]: value },
    }));
  };

  const parseScore = (value: string): { score: number | null; error?: string } => {
    if (value === "") {
      return { score: null };
    }
    const num = Number(value);
    if (Number.isNaN(num) || num < 0 || num > 10) {
      return { score: null, error: "0〜10で入力してください。" };
    }
    return { score: num };
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof ConditionFormData, string>> = {};
    if (!form.recordedAt) {
      errors.recordedAt = "日時を入力してください。";
    }
    if (form.bodyTemperatureC !== "") {
      const temp = Number(form.bodyTemperatureC);
      if (Number.isNaN(temp) || temp < 30 || temp > 45) {
        errors.bodyTemperatureC = "体温は30〜45℃で入力してください。";
      }
    }
    for (const field of SCORE_FIELDS) {
      const result = parseScore(form[field.key]);
      if (result.error) {
        errors[field.key] = result.error;
      }
    }
    const freeText = form.freeTextSymptoms
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (freeText.length > 10) {
      errors.freeTextSymptoms = "自由記述症状は10件までです。";
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }

    const symptoms = Object.entries(selectedSymptoms).map(([typeId, value]) => ({
      symptomTypeId: typeId,
      severity: value.severity !== "" ? Number(value.severity) : null,
      note: value.note.trim() || null,
    }));

    const freeTextSymptoms = form.freeTextSymptoms
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 10);

    onSubmit({
      ...(editingEntry ? { id: editingEntry.id, expectedRowVersion: editingEntry.rowVersion } : {}),
      recordedAt: parseDateTimeLocal(form.recordedAt).toISOString(),
      timezone: form.timezone.trim() || "Asia/Tokyo",
      overallScore: parseScore(form.overallScore).score,
      fatigueScore: parseScore(form.fatigueScore).score,
      energyScore: parseScore(form.energyScore).score,
      stressScore: parseScore(form.stressScore).score,
      painScore: parseScore(form.painScore).score,
      moodScore: parseScore(form.moodScore).score,
      bodyTemperatureC: form.bodyTemperatureC !== "" ? Number(form.bodyTemperatureC) : null,
      freeTextSymptoms,
      symptoms,
      note: form.note.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingEntry ? "edit-condition-heading" : "new-condition-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={editingEntry ? "edit-condition-heading" : "new-condition-heading"}
      >
        {editingEntry ? "体調記録を編集" : "新規体調記録"}
      </h2>
      {serverError ? (
        <p className={`${styles.status} ${styles.statusError}`} role="alert">
          {serverError}
        </p>
      ) : null}
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.row}>
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

          <div className={styles.field}>
            <label className={styles.label} htmlFor={timezoneId}>
              タイムゾーン
            </label>
            <input
              id={timezoneId}
              className={styles.input}
              type="text"
              value={form.timezone}
              onChange={(event) => handleChange("timezone", event.target.value)}
              disabled={disabled}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={temperatureId}>
              体温（℃）
            </label>
            <input
              id={temperatureId}
              className={styles.input}
              type="number"
              step="0.1"
              inputMode="decimal"
              value={form.bodyTemperatureC}
              placeholder="未入力"
              onChange={(event) => handleChange("bodyTemperatureC", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.bodyTemperatureC)}
              aria-describedby={fieldErrors.bodyTemperatureC ? `${temperatureId}-error` : undefined}
            />
            {fieldErrors.bodyTemperatureC ? (
              <p className={styles.fieldError} id={`${temperatureId}-error`}>
                {fieldErrors.bodyTemperatureC}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>主観指標（0〜10）</span>
          <div className={styles.scoreRow}>
            {SCORE_FIELDS.map((field) => {
              const id = `${field.key}-score`;
              return (
                <div className={styles.field} key={field.key}>
                  <label className={styles.label} htmlFor={id}>
                    {field.label}
                  </label>
                  <input
                    id={id}
                    className={styles.input}
                    type="number"
                    min={0}
                    max={10}
                    inputMode="numeric"
                    value={form[field.key]}
                    placeholder="未入力"
                    onChange={(event) => handleChange(field.key, event.target.value)}
                    disabled={disabled}
                    aria-invalid={Boolean(fieldErrors[field.key])}
                    aria-describedby={fieldErrors[field.key] ? `${id}-error` : undefined}
                  />
                  {fieldErrors[field.key] ? (
                    <p className={styles.fieldError} id={`${id}-error`}>
                      {fieldErrors[field.key]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>症状</span>
          <div className={styles.symptomGrid}>
            {symptomTypes
              .filter((type) => type.archivedAt === null)
              .map((type) => {
                const selected = selectedSymptoms[type.id];
                return (
                  <div key={type.id} className={styles.symptomItem}>
                    <input
                      id={`symptom-${type.id}`}
                      className={styles.checkbox}
                      type="checkbox"
                      checked={Boolean(selected)}
                      onChange={() => toggleSymptom(type.id)}
                      disabled={disabled}
                    />
                    <label htmlFor={`symptom-${type.id}`}>{type.displayName}</label>
                    {selected ? (
                      <>
                        <input
                          className={styles.input}
                          type="number"
                          min={0}
                          max={10}
                          inputMode="numeric"
                          placeholder="重さ"
                          value={selected.severity}
                          onChange={(event) =>
                            updateSymptom(type.id, "severity", event.target.value)
                          }
                          disabled={disabled}
                          aria-label={`${type.displayName}の重さ`}
                        />
                        <input
                          className={styles.input}
                          type="text"
                          placeholder="メモ"
                          value={selected.note}
                          onChange={(event) => updateSymptom(type.id, "note", event.target.value)}
                          disabled={disabled}
                          aria-label={`${type.displayName}のメモ`}
                        />
                      </>
                    ) : null}
                  </div>
                );
              })}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={freeTextId}>
            自由記述症状（カンマ区切り、10件まで）
          </label>
          <input
            id={freeTextId}
            className={styles.input}
            type="text"
            value={form.freeTextSymptoms}
            onChange={(event) => handleChange("freeTextSymptoms", event.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(fieldErrors.freeTextSymptoms)}
            aria-describedby={fieldErrors.freeTextSymptoms ? `${freeTextId}-error` : undefined}
          />
          {fieldErrors.freeTextSymptoms ? (
            <p className={styles.fieldError} id={`${freeTextId}-error`}>
              {fieldErrors.freeTextSymptoms}
            </p>
          ) : null}
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

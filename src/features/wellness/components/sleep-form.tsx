"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { SleepEntry } from "../schema";
import {
  findSleepChronologyViolations,
  SLEEP_KIND_LABELS,
  SLEEP_KINDS,
  type SleepKind,
} from "../units";
import { parseDateTimeLocal, toDateTimeLocalValue } from "../utils";
import styles from "../wellness.module.css";

type SleepFormData = {
  sleepKind: SleepKind;
  bedAt: string;
  sleepAt: string;
  wakeAt: string;
  outOfBedAt: string;
  timezone: string;
  awakeningsCount: string;
  awakeMinutes: string;
  quality: string;
  morningFeeling: string;
  note: string;
};

function emptyForm(): SleepFormData {
  const now = new Date();
  const bed = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const sleep = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const wake = new Date(now.getTime() - 15 * 60 * 1000);
  return {
    sleepKind: "night",
    bedAt: toDateTimeLocalValue(bed),
    sleepAt: toDateTimeLocalValue(sleep),
    wakeAt: toDateTimeLocalValue(wake),
    outOfBedAt: toDateTimeLocalValue(now),
    timezone: "Asia/Tokyo",
    awakeningsCount: "0",
    awakeMinutes: "0",
    quality: "",
    morningFeeling: "",
    note: "",
  };
}

function entryToForm(entry: SleepEntry): SleepFormData {
  return {
    sleepKind: entry.sleepKind,
    bedAt: toDateTimeLocalValue(new Date(entry.bedAt)),
    sleepAt: toDateTimeLocalValue(new Date(entry.sleepAt)),
    wakeAt: toDateTimeLocalValue(new Date(entry.wakeAt)),
    outOfBedAt: toDateTimeLocalValue(new Date(entry.outOfBedAt)),
    timezone: entry.timezone,
    awakeningsCount: String(entry.awakeningsCount),
    awakeMinutes: String(entry.awakeMinutes),
    quality: entry.quality !== null ? String(entry.quality) : "",
    morningFeeling: entry.morningFeeling !== null ? String(entry.morningFeeling) : "",
    note: entry.note ?? "",
  };
}

type SleepFormProps = {
  editingEntry: SleepEntry | null;
  onSubmit: (input: {
    id?: string;
    expectedRowVersion?: number;
    sleepKind: SleepKind;
    bedAt: string;
    sleepAt: string;
    wakeAt: string;
    outOfBedAt: string;
    timezone: string;
    awakeningsCount: number;
    awakeMinutes: number;
    quality: number | null;
    morningFeeling: number | null;
    note: string | null;
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function SleepForm({
  editingEntry,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: SleepFormProps) {
  const [form, setForm] = useState<SleepFormData>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof SleepFormData, string>>>({});

  const kindId = useId();
  const bedId = useId();
  const sleepId = useId();
  const wakeId = useId();
  const outOfBedId = useId();
  const timezoneId = useId();
  const awakeningsId = useId();
  const awakeMinutesId = useId();
  const qualityId = useId();
  const morningFeelingId = useId();
  const noteId = useId();

  const previousEditingId = useRef<string | null>(null);

  useEffect(() => {
    const editingId = editingEntry?.id ?? null;
    if (editingId === previousEditingId.current) {
      return;
    }
    previousEditingId.current = editingId;
    setForm(editingEntry ? entryToForm(editingEntry) : emptyForm());
    setFieldErrors({});
  }, [editingEntry]);

  const handleChange = (field: keyof SleepFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof SleepFormData, string>> = {};
    if (!SLEEP_KINDS.includes(form.sleepKind)) {
      errors.sleepKind = "種別を選んでください。";
    }
    if (!form.bedAt) {
      errors.bedAt = "就床日時を入力してください。";
    }
    if (!form.sleepAt) {
      errors.sleepAt = "入眠日時を入力してください。";
    }
    if (!form.wakeAt) {
      errors.wakeAt = "起床日時を入力してください。";
    }
    if (!form.outOfBedAt) {
      errors.outOfBedAt = "離床日時を入力してください。";
    }

    const awakeningsCount = Number(form.awakeningsCount);
    if (
      form.awakeningsCount === "" ||
      Number.isNaN(awakeningsCount) ||
      awakeningsCount < 0 ||
      awakeningsCount > 30
    ) {
      errors.awakeningsCount = "中途覚醒回数は0〜30で入力してください。";
    }
    const awakeMinutes = Number(form.awakeMinutes);
    if (
      form.awakeMinutes === "" ||
      Number.isNaN(awakeMinutes) ||
      awakeMinutes < 0 ||
      awakeMinutes > 720
    ) {
      errors.awakeMinutes = "覚醒時間は0〜720分で入力してください。";
    }

    let quality: number | null = null;
    if (form.quality !== "") {
      quality = Number(form.quality);
      if (Number.isNaN(quality) || quality < 1 || quality > 5) {
        errors.quality = "睡眠の質は1〜5で入力してください。";
      }
    }
    let morningFeeling: number | null = null;
    if (form.morningFeeling !== "") {
      morningFeeling = Number(form.morningFeeling);
      if (Number.isNaN(morningFeeling) || morningFeeling < 1 || morningFeeling > 5) {
        errors.morningFeeling = "起床時の感覚は1〜5で入力してください。";
      }
    }

    // 日時の順序・上限チェック（実装仕様書 5.5節）
    if (!errors.bedAt && !errors.sleepAt && !errors.wakeAt && !errors.outOfBedAt) {
      const violations = findSleepChronologyViolations({
        bedAt: parseDateTimeLocal(form.bedAt).toISOString(),
        sleepAt: parseDateTimeLocal(form.sleepAt).toISOString(),
        wakeAt: parseDateTimeLocal(form.wakeAt).toISOString(),
        outOfBedAt: parseDateTimeLocal(form.outOfBedAt).toISOString(),
        awakeMinutes,
      });
      if (violations.length > 0) {
        const messages: Record<string, string> = {
          order: "就床≦入眠＜起床≦離床の順序で入力してください。",
          span_over_24_hours: "就床から離床までが24時間を超えています。",
          awake_not_shorter_than_sleep: "覚醒時間が睡眠時間以上になっています。",
          invalid_datetime: "日時の形式が正しくありません。",
        };
        errors.sleepAt =
          messages[violations[0] ?? "invalid_datetime"] ?? "日時の入力を確認してください。";
      }
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
      sleepKind: form.sleepKind,
      bedAt: parseDateTimeLocal(form.bedAt).toISOString(),
      sleepAt: parseDateTimeLocal(form.sleepAt).toISOString(),
      wakeAt: parseDateTimeLocal(form.wakeAt).toISOString(),
      outOfBedAt: parseDateTimeLocal(form.outOfBedAt).toISOString(),
      timezone: form.timezone.trim() || "Asia/Tokyo",
      awakeningsCount: Number(form.awakeningsCount),
      awakeMinutes: Number(form.awakeMinutes),
      quality: form.quality !== "" ? Number(form.quality) : null,
      morningFeeling: form.morningFeeling !== "" ? Number(form.morningFeeling) : null,
      note: form.note.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingEntry ? "edit-sleep-heading" : "new-sleep-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={editingEntry ? "edit-sleep-heading" : "new-sleep-heading"}
      >
        {editingEntry ? "睡眠記録を編集" : "新規睡眠記録"}
      </h2>
      {serverError ? (
        <p className={`${styles.status} ${styles.statusError}`} role="alert">
          {serverError}
        </p>
      ) : null}
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={kindId}>
              種別
            </label>
            <select
              id={kindId}
              className={styles.select}
              value={form.sleepKind}
              onChange={(event) => handleChange("sleepKind", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.sleepKind)}
              aria-describedby={fieldErrors.sleepKind ? `${kindId}-error` : undefined}
            >
              {SLEEP_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {SLEEP_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            {fieldErrors.sleepKind ? (
              <p className={styles.fieldError} id={`${kindId}-error`}>
                {fieldErrors.sleepKind}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={bedId}>
              就床
            </label>
            <input
              id={bedId}
              className={styles.input}
              type="datetime-local"
              value={form.bedAt}
              onChange={(event) => handleChange("bedAt", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.bedAt)}
              aria-describedby={fieldErrors.bedAt ? `${bedId}-error` : undefined}
            />
            {fieldErrors.bedAt ? (
              <p className={styles.fieldError} id={`${bedId}-error`}>
                {fieldErrors.bedAt}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={sleepId}>
              入眠
            </label>
            <input
              id={sleepId}
              className={styles.input}
              type="datetime-local"
              value={form.sleepAt}
              onChange={(event) => handleChange("sleepAt", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.sleepAt)}
              aria-describedby={fieldErrors.sleepAt ? `${sleepId}-error` : undefined}
            />
            {fieldErrors.sleepAt ? (
              <p className={styles.fieldError} id={`${sleepId}-error`}>
                {fieldErrors.sleepAt}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={wakeId}>
              起床
            </label>
            <input
              id={wakeId}
              className={styles.input}
              type="datetime-local"
              value={form.wakeAt}
              onChange={(event) => handleChange("wakeAt", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.wakeAt)}
              aria-describedby={fieldErrors.wakeAt ? `${wakeId}-error` : undefined}
            />
            {fieldErrors.wakeAt ? (
              <p className={styles.fieldError} id={`${wakeId}-error`}>
                {fieldErrors.wakeAt}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={outOfBedId}>
              離床
            </label>
            <input
              id={outOfBedId}
              className={styles.input}
              type="datetime-local"
              value={form.outOfBedAt}
              onChange={(event) => handleChange("outOfBedAt", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.outOfBedAt)}
              aria-describedby={fieldErrors.outOfBedAt ? `${outOfBedId}-error` : undefined}
            />
            {fieldErrors.outOfBedAt ? (
              <p className={styles.fieldError} id={`${outOfBedId}-error`}>
                {fieldErrors.outOfBedAt}
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
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={awakeningsId}>
              中途覚醒回数
            </label>
            <input
              id={awakeningsId}
              className={styles.input}
              type="number"
              min={0}
              max={30}
              inputMode="numeric"
              value={form.awakeningsCount}
              onChange={(event) => handleChange("awakeningsCount", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.awakeningsCount)}
              aria-describedby={fieldErrors.awakeningsCount ? `${awakeningsId}-error` : undefined}
            />
            {fieldErrors.awakeningsCount ? (
              <p className={styles.fieldError} id={`${awakeningsId}-error`}>
                {fieldErrors.awakeningsCount}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={awakeMinutesId}>
              覚醒時間（分）
            </label>
            <input
              id={awakeMinutesId}
              className={styles.input}
              type="number"
              min={0}
              max={720}
              inputMode="numeric"
              value={form.awakeMinutes}
              onChange={(event) => handleChange("awakeMinutes", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.awakeMinutes)}
              aria-describedby={fieldErrors.awakeMinutes ? `${awakeMinutesId}-error` : undefined}
            />
            {fieldErrors.awakeMinutes ? (
              <p className={styles.fieldError} id={`${awakeMinutesId}-error`}>
                {fieldErrors.awakeMinutes}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={qualityId}>
              睡眠の質（1〜5）
            </label>
            <input
              id={qualityId}
              className={styles.input}
              type="number"
              min={1}
              max={5}
              inputMode="numeric"
              value={form.quality}
              placeholder="未入力"
              onChange={(event) => handleChange("quality", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.quality)}
              aria-describedby={fieldErrors.quality ? `${qualityId}-error` : undefined}
            />
            {fieldErrors.quality ? (
              <p className={styles.fieldError} id={`${qualityId}-error`}>
                {fieldErrors.quality}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={morningFeelingId}>
              起床時の感覚（1〜5）
            </label>
            <input
              id={morningFeelingId}
              className={styles.input}
              type="number"
              min={1}
              max={5}
              inputMode="numeric"
              value={form.morningFeeling}
              placeholder="未入力"
              onChange={(event) => handleChange("morningFeeling", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.morningFeeling)}
              aria-describedby={
                fieldErrors.morningFeeling ? `${morningFeelingId}-error` : undefined
              }
            />
            {fieldErrors.morningFeeling ? (
              <p className={styles.fieldError} id={`${morningFeelingId}-error`}>
                {fieldErrors.morningFeeling}
              </p>
            ) : null}
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

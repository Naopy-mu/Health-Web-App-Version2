"use client";

import { useEffect, useId, useMemo, useState } from "react";

import type { HydrationGoal, HydrationGoalInput, SleepGoal, SleepGoalInput } from "../schema";
import { WEEKDAYS, WEEKDAY_LABELS } from "../units";
import { toDateInputValue } from "../utils";
import type { ConflictInfo } from "../use-wellness";
import { ConflictBanner } from "./conflict-banner";
import styles from "../wellness.module.css";

type GoalManagerProps = {
  resource: "sleep" | "hydration";
  goals: (SleepGoal | HydrationGoal)[];
  onSave: (goal: SleepGoalInput | HydrationGoalInput) => Promise<boolean> | boolean;
  onDelete: (goal: SleepGoal | HydrationGoal) => Promise<boolean> | boolean;
  disabled: boolean;
  serverError: string | null;
  conflict?: ConflictInfo | null;
};

type GoalFormData = {
  targetSleepMinutes: string;
  targetAmountMl: string;
  weekdays: number[];
  targetBedtime: string;
  targetWakeTime: string;
  startDate: string;
  endDate: string;
  note: string;
};

function emptyForm(): GoalFormData {
  return {
    targetSleepMinutes: "420",
    targetAmountMl: "2000",
    weekdays: [...WEEKDAYS],
    targetBedtime: "",
    targetWakeTime: "",
    startDate: toDateInputValue(new Date()),
    endDate: "",
    note: "",
  };
}

function sleepGoalToForm(goal: SleepGoal): GoalFormData {
  return {
    targetSleepMinutes: String(goal.targetSleepMinutes),
    targetAmountMl: "2000",
    weekdays: [...goal.weekdays],
    targetBedtime: goal.targetBedtime ?? "",
    targetWakeTime: goal.targetWakeTime ?? "",
    startDate: goal.startDate,
    endDate: goal.endDate ?? "",
    note: goal.note ?? "",
  };
}

function hydrationGoalToForm(goal: HydrationGoal): GoalFormData {
  return {
    targetSleepMinutes: "420",
    targetAmountMl: String(goal.targetAmountMl),
    weekdays: [...goal.weekdays],
    targetBedtime: "",
    targetWakeTime: "",
    startDate: goal.startDate,
    endDate: goal.endDate ?? "",
    note: goal.note ?? "",
  };
}

export function GoalManager({
  resource,
  goals,
  onSave,
  onDelete,
  disabled,
  serverError,
  conflict,
}: GoalManagerProps) {
  const [editingGoal, setEditingGoal] = useState<SleepGoal | HydrationGoal | null>(null);
  const [form, setForm] = useState<GoalFormData>(emptyForm());
  const [errors, setErrors] = useState<Partial<Record<keyof GoalFormData, string>>>({});

  const targetId = useId();
  const bedtimeId = useId();
  const wakeTimeId = useId();
  const startDateId = useId();
  const endDateId = useId();
  const noteId = useId();

  const isSleep = resource === "sleep";

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (editingGoal) {
      setForm(
        isSleep
          ? sleepGoalToForm(editingGoal as SleepGoal)
          : hydrationGoalToForm(editingGoal as HydrationGoal),
      );
    } else {
      setForm(emptyForm());
    }
    setErrors({});
  }, [editingGoal, isSleep]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const activeGoal = useMemo(() => goals.find((goal) => goal.endDate === null), [goals]);

  const handleChange = (field: keyof GoalFormData, value: string | number[]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const toggleWeekday = (day: number) => {
    setForm((prev) => {
      const next = prev.weekdays.includes(day)
        ? prev.weekdays.filter((d) => d !== day)
        : [...prev.weekdays, day].sort((a, b) => a - b);
      return { ...prev, weekdays: next };
    });
  };

  const validate = (): boolean => {
    const nextErrors: typeof errors = {};
    if (isSleep) {
      const minutes = Number(form.targetSleepMinutes);
      if (
        form.targetSleepMinutes === "" ||
        Number.isNaN(minutes) ||
        minutes < 60 ||
        minutes > 1440
      ) {
        nextErrors.targetSleepMinutes = "目標睡眠時間は60〜1440分で入力してください。";
      }
    } else {
      const ml = Number(form.targetAmountMl);
      if (form.targetAmountMl === "" || Number.isNaN(ml) || ml <= 0 || ml > 20000) {
        nextErrors.targetAmountMl = "目標量は0より大きく20,000ml以下で入力してください。";
      }
    }
    if (form.weekdays.length === 0) {
      nextErrors.weekdays = "対象曜日を1つ以上選んでください。";
    }
    if (!form.startDate) {
      nextErrors.startDate = "開始日を入力してください。";
    }
    if (form.endDate && form.endDate < form.startDate) {
      nextErrors.endDate = "終了日は開始日以降にしてください。";
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    const base = {
      weekdays: form.weekdays,
      startDate: form.startDate,
      endDate: form.endDate.trim() || null,
      note: form.note.trim() || null,
      timezone: "Asia/Tokyo",
    };
    const payload: SleepGoalInput | HydrationGoalInput = isSleep
      ? {
          ...base,
          targetSleepMinutes: Number(form.targetSleepMinutes),
          targetBedtime: form.targetBedtime.trim() || null,
          targetWakeTime: form.targetWakeTime.trim() || null,
        }
      : {
          ...base,
          targetAmountMl: Number(form.targetAmountMl),
        };
    const ok = await onSave({
      ...(editingGoal ? { id: editingGoal.id, expectedRowVersion: editingGoal.rowVersion } : {}),
      ...payload,
    });
    if (ok) {
      setEditingGoal(null);
      setForm(emptyForm());
    }
  };

  return (
    <div>
      <section className={styles.card} aria-labelledby="goals-heading">
        <h2 className={styles.sectionTitle} id="goals-heading">
          目標一覧
        </h2>
        {serverError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {serverError}
          </p>
        ) : null}
        {conflict ? <ConflictBanner conflict={conflict} /> : null}
        {goals.length === 0 ? (
          <p className={styles.empty}>目標が登録されていません。</p>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">開始日</th>
                  <th scope="col">終了日</th>
                  <th scope="col">目標</th>
                  <th scope="col">対象曜日</th>
                  {isSleep ? <th scope="col">就床／起床</th> : null}
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {goals.map((goal) => (
                  <tr
                    key={goal.id}
                    className={goal.endDate === null ? styles.goalAchieved : undefined}
                  >
                    <td>{goal.startDate}</td>
                    <td>{goal.endDate ?? "現在の目標"}</td>
                    <td>
                      {isSleep
                        ? `${(goal as SleepGoal).targetSleepMinutes}分`
                        : `${(goal as HydrationGoal).targetAmountMl}ml`}
                    </td>
                    <td>
                      {goal.weekdays
                        .map((d) => WEEKDAY_LABELS[d as keyof typeof WEEKDAY_LABELS])
                        .join(",")}
                    </td>
                    {isSleep ? (
                      <td>
                        {(goal as SleepGoal).targetBedtime ?? "—"} /{" "}
                        {(goal as SleepGoal).targetWakeTime ?? "—"}
                      </td>
                    ) : null}
                    <td>
                      <div className={styles.buttonGroup}>
                        <button
                          className={`${styles.button} ${styles.buttonSecondary}`}
                          type="button"
                          onClick={() => setEditingGoal(goal)}
                          disabled={disabled}
                        >
                          編集
                        </button>
                        <button
                          className={`${styles.button} ${styles.buttonDanger}`}
                          type="button"
                          onClick={() => onDelete(goal)}
                          disabled={disabled}
                        >
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        className={styles.card}
        aria-labelledby={editingGoal ? "edit-goal-heading" : "new-goal-heading"}
      >
        <h2
          className={styles.sectionTitle}
          id={editingGoal ? "edit-goal-heading" : "new-goal-heading"}
        >
          {editingGoal ? "目標を編集" : "新規目標"}
        </h2>
        {!editingGoal && activeGoal ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            現在の目標が既にあります。新しい目標を作る前に、既存の目標に終了日を入れてください。
          </p>
        ) : null}
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={targetId}>
                {isSleep ? "目標睡眠時間（分）" : "目標量（ml）"}
              </label>
              <input
                id={targetId}
                className={styles.input}
                type="number"
                inputMode="numeric"
                value={isSleep ? form.targetSleepMinutes : form.targetAmountMl}
                onChange={(event) =>
                  handleChange(
                    isSleep ? "targetSleepMinutes" : "targetAmountMl",
                    event.target.value,
                  )
                }
                disabled={disabled}
                aria-invalid={Boolean(errors.targetSleepMinutes || errors.targetAmountMl)}
                aria-describedby={
                  errors.targetSleepMinutes || errors.targetAmountMl
                    ? `${targetId}-error`
                    : undefined
                }
              />
              {errors.targetSleepMinutes || errors.targetAmountMl ? (
                <p className={styles.fieldError} id={`${targetId}-error`}>
                  {errors.targetSleepMinutes || errors.targetAmountMl}
                </p>
              ) : null}
            </div>

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
                aria-invalid={Boolean(errors.startDate)}
                aria-describedby={errors.startDate ? `${startDateId}-error` : undefined}
              />
              {errors.startDate ? (
                <p className={styles.fieldError} id={`${startDateId}-error`}>
                  {errors.startDate}
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
                aria-invalid={Boolean(errors.endDate)}
                aria-describedby={errors.endDate ? `${endDateId}-error` : undefined}
              />
              {errors.endDate ? (
                <p className={styles.fieldError} id={`${endDateId}-error`}>
                  {errors.endDate}
                </p>
              ) : null}
            </div>
          </div>

          {isSleep ? (
            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={bedtimeId}>
                  目標就床時刻（任意）
                </label>
                <input
                  id={bedtimeId}
                  className={styles.input}
                  type="time"
                  value={form.targetBedtime}
                  onChange={(event) => handleChange("targetBedtime", event.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={wakeTimeId}>
                  目標起床時刻（任意）
                </label>
                <input
                  id={wakeTimeId}
                  className={styles.input}
                  type="time"
                  value={form.targetWakeTime}
                  onChange={(event) => handleChange("targetWakeTime", event.target.value)}
                  disabled={disabled}
                />
              </div>
            </div>
          ) : null}

          <div className={styles.field}>
            <span className={styles.label}>対象曜日</span>
            <div className={styles.buttonGroup} role="group" aria-label="対象曜日">
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  className={`${styles.button} ${form.weekdays.includes(day) ? "" : styles.buttonSecondary}`}
                  onClick={() => toggleWeekday(day)}
                  disabled={disabled}
                  aria-pressed={form.weekdays.includes(day)}
                >
                  {WEEKDAY_LABELS[day]}
                </button>
              ))}
            </div>
            {errors.weekdays ? <p className={styles.fieldError}>{errors.weekdays}</p> : null}
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
            <button
              className={styles.button}
              type="submit"
              disabled={disabled || (!editingGoal && Boolean(activeGoal))}
            >
              {disabled ? "送信中…" : editingGoal ? "更新する" : "目標を設定する"}
            </button>
            {editingGoal ? (
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                type="button"
                onClick={() => setEditingGoal(null)}
                disabled={disabled}
              >
                キャンセル
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}

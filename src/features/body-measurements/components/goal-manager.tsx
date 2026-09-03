"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { MeasurementGoal, MeasurementType } from "../schema";
import { isUnitAllowedFor, type MeasurementUnit, UNITS_BY_CONSTRAINT } from "../units";
import type { ConflictInfo } from "../use-measurements";
import { ConflictBanner } from "./conflict-banner";
import { findUnachievedGoal, formatValue, toDateTimeLocalValue } from "../utils";
import styles from "../measurements.module.css";

type GoalFormData = {
  typeId: string;
  targetValue: string;
  unit: string;
  startValue: string;
  targetDate: string;
  note: string;
  achievedAt: string;
};

function emptyForm(): GoalFormData {
  return {
    typeId: "",
    targetValue: "",
    unit: "",
    startValue: "",
    targetDate: "",
    note: "",
    achievedAt: "",
  };
}

function goalToFormData(goal: MeasurementGoal): GoalFormData {
  return {
    typeId: goal.typeId,
    targetValue: String(goal.targetValue),
    unit: goal.unit,
    startValue: goal.startValue !== null ? String(goal.startValue) : "",
    targetDate: goal.targetDate ?? "",
    note: goal.note ?? "",
    achievedAt: goal.achievedAt ? toDateTimeLocalValue(new Date(goal.achievedAt)) : "",
  };
}

type GoalManagerProps = {
  /** 全種別（アーカイブ済みも含む）。目標の履歴表示に使う（S4）。 */
  types: MeasurementType[];
  /** 有効な種別。新規作成・編集時の選択肢に使う。 */
  activeTypes: MeasurementType[];
  goals: MeasurementGoal[];
  editingGoal: MeasurementGoal | null;
  onSetEditingGoal: (goal: MeasurementGoal | null) => void;
  onSave: (input: {
    id?: string;
    expectedRowVersion?: number;
    typeId: string;
    targetValue: number;
    unit: MeasurementUnit;
    startValue: number | null;
    targetDate: string | null;
    note: string | null;
    achievedAt: string | null;
  }) => Promise<boolean> | boolean;
  onDelete: (goal: MeasurementGoal) => Promise<boolean> | boolean;
  disabled: boolean;
  serverError: string | null;
  conflict?: ConflictInfo | null;
};

export function GoalManager({
  types,
  activeTypes,
  goals,
  editingGoal,
  onSetEditingGoal,
  onSave,
  onDelete,
  disabled,
  serverError,
  conflict,
}: GoalManagerProps) {
  const [form, setForm] = useState<GoalFormData>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof GoalFormData, string>>>({});

  const typeId = useId();
  const targetId = useId();
  const unitId = useId();
  const startId = useId();
  const dateId = useId();
  const noteId = useId();
  const achievedId = useId();

  const selectedType = useMemo(
    () => activeTypes.find((type) => type.id === form.typeId),
    [activeTypes, form.typeId],
  );

  const previousEditingId = useRef<string | null>(null);
  const previousActiveTypeId = useRef<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const editingId = editingGoal?.id ?? null;
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

    if (editingGoal) {
      setForm(goalToFormData(editingGoal));
    } else if (activeTypes.length === 0) {
      // 種別ロード前は既存の入力を保持し、空フォームへのリセットは行わない（SF-3）。
      return;
    } else {
      setForm((prev) => {
        if (prev.typeId && prev.unit) {
          // 利用者が既に入力を始めている場合は値を保持する（S1）。
          return prev;
        }
        const initial = emptyForm();
        initial.typeId = activeTypes[0].id;
        initial.unit = activeTypes[0].defaultUnit;
        return initial;
      });
    }
    setErrors({});
  }, [editingGoal, activeTypes]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  const handleChange = (field: keyof GoalFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = (): boolean => {
    const nextErrors: typeof errors = {};
    if (!form.typeId) {
      nextErrors.typeId = "測定種別を選択してください。";
    }
    const targetValue = Number(form.targetValue);
    if (
      form.targetValue === "" ||
      Number.isNaN(targetValue) ||
      targetValue <= 0 ||
      targetValue > 1000
    ) {
      nextErrors.targetValue = "目標値は0より大きく1000以下で入力してください。";
    }
    if (!form.unit) {
      nextErrors.unit = "単位を選択してください。";
    }
    if (form.startValue) {
      const startValue = Number(form.startValue);
      if (Number.isNaN(startValue) || startValue <= 0 || startValue > 1000) {
        nextErrors.startValue = "開始値は0より大きく1000以下で入力してください。";
      }
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const resetForm = () => {
    onSetEditingGoal(null);
    setForm(emptyForm());
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    const ok = await onSave({
      ...(editingGoal ? { id: editingGoal.id, expectedRowVersion: editingGoal.rowVersion } : {}),
      typeId: form.typeId,
      targetValue: Number(form.targetValue),
      unit: form.unit as MeasurementUnit,
      startValue: form.startValue ? Number(form.startValue) : null,
      targetDate: form.targetDate || null,
      note: form.note.trim() || null,
      achievedAt: form.achievedAt ? new Date(form.achievedAt).toISOString() : null,
    });
    if (ok) {
      resetForm();
    }
  };

  const groupedGoals = useMemo(() => {
    const map = new Map<string, MeasurementGoal[]>();
    for (const goal of goals) {
      const list = map.get(goal.typeId) ?? [];
      list.push(goal);
      map.set(goal.typeId, list);
    }
    return map;
  }, [goals]);

  return (
    <div>
      <section className={styles.card} aria-labelledby="goals-heading">
        <h2 className={styles.sectionTitle} id="goals-heading">
          測定目標一覧
        </h2>
        {serverError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {serverError}
          </p>
        ) : null}
        {conflict ? <ConflictBanner conflict={conflict} /> : null}

        {types.length === 0 ? (
          <p className={styles.empty}>測定種別が登録されていません。</p>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">種別</th>
                  <th scope="col">目標値</th>
                  <th scope="col">開始値</th>
                  <th scope="col">目標日</th>
                  <th scope="col">達成日時</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {types.map((type) => {
                  const typeGoals = groupedGoals.get(type.id) ?? [];
                  if (typeGoals.length === 0) {
                    return (
                      <tr key={type.id}>
                        <td>
                          {type.displayName}
                          {type.archivedAt ? (
                            <span className={styles.typeDefault}>（アーカイブ済み）</span>
                          ) : null}
                        </td>
                        <td colSpan={5} className={styles.empty}>
                          目標がありません
                        </td>
                      </tr>
                    );
                  }
                  return typeGoals.map((goal) => (
                    <tr key={goal.id} className={goal.achievedAt ? styles.goalAchieved : undefined}>
                      <td>
                        {type.displayName}
                        {type.archivedAt ? (
                          <span className={styles.typeDefault}>（アーカイブ済み）</span>
                        ) : null}
                      </td>
                      <td>{formatValue(goal.targetValue, goal.unit)}</td>
                      <td>{goal.startValue !== null ? goal.startValue : "—"}</td>
                      <td>{goal.targetDate ?? "—"}</td>
                      <td>
                        {goal.achievedAt
                          ? toDateTimeLocalValue(new Date(goal.achievedAt))
                          : "未達成"}
                      </td>
                      <td>
                        <div className={styles.buttonGroup}>
                          <button
                            className={`${styles.button} ${styles.buttonSecondary}`}
                            type="button"
                            onClick={() => onSetEditingGoal(goal)}
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
                  ));
                })}
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
        {selectedType && !editingGoal && findUnachievedGoal(goals, selectedType.id) ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            「{selectedType.displayName}
            」には未達成の目標が既にあります。新規作成する前に既存の目標を達成させるか削除してください。
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
                disabled={disabled || activeTypes.length === 0 || Boolean(editingGoal)}
                aria-invalid={Boolean(errors.typeId)}
                aria-describedby={errors.typeId ? `${typeId}-error` : undefined}
              >
                {activeTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.displayName}
                  </option>
                ))}
              </select>
              {errors.typeId ? (
                <p className={styles.fieldError} id={`${typeId}-error`}>
                  {errors.typeId}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={targetId}>
                目標値
              </label>
              <input
                id={targetId}
                className={styles.input}
                type="number"
                step="any"
                inputMode="decimal"
                value={form.targetValue}
                onChange={(event) => handleChange("targetValue", event.target.value)}
                disabled={disabled}
                aria-invalid={Boolean(errors.targetValue)}
                aria-describedby={errors.targetValue ? `${targetId}-error` : undefined}
              />
              {errors.targetValue ? (
                <p className={styles.fieldError} id={`${targetId}-error`}>
                  {errors.targetValue}
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
                aria-invalid={Boolean(errors.unit)}
                aria-describedby={errors.unit ? `${unitId}-error` : undefined}
              >
                {allowedUnits.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
              {errors.unit ? (
                <p className={styles.fieldError} id={`${unitId}-error`}>
                  {errors.unit}
                </p>
              ) : null}
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={startId}>
                開始値（任意）
              </label>
              <input
                id={startId}
                className={styles.input}
                type="number"
                step="any"
                inputMode="decimal"
                value={form.startValue}
                onChange={(event) => handleChange("startValue", event.target.value)}
                disabled={disabled}
                aria-invalid={Boolean(errors.startValue)}
                aria-describedby={errors.startValue ? `${startId}-error` : undefined}
              />
              {errors.startValue ? (
                <p className={styles.fieldError} id={`${startId}-error`}>
                  {errors.startValue}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={dateId}>
                目標日（任意）
              </label>
              <input
                id={dateId}
                className={styles.input}
                type="date"
                value={form.targetDate}
                onChange={(event) => handleChange("targetDate", event.target.value)}
                disabled={disabled}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={achievedId}>
                達成日時（任意）
              </label>
              <input
                id={achievedId}
                className={styles.input}
                type="datetime-local"
                value={form.achievedAt}
                onChange={(event) => handleChange("achievedAt", event.target.value)}
                disabled={disabled}
              />
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
            <button
              className={styles.button}
              type="submit"
              disabled={
                disabled ||
                (!editingGoal && selectedType
                  ? Boolean(findUnachievedGoal(goals, selectedType.id))
                  : false)
              }
            >
              {disabled ? "送信中…" : editingGoal ? "更新する" : "目標を設定する"}
            </button>
            {editingGoal ? (
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                type="button"
                onClick={() => onSetEditingGoal(null)}
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

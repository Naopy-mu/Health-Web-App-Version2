"use client";

import { useId, useMemo, useState } from "react";

import type { MeasurementType } from "../schema";
import { isDefaultMeasurementKey } from "../defaults";
import { MEASUREMENT_KEY_PATTERN } from "../schema";
import { isUnitAllowedFor, UNITS_BY_CONSTRAINT } from "../units";
import styles from "../measurements.module.css";

type TypeManagerProps = {
  activeTypes: MeasurementType[];
  archivedTypes: MeasurementType[];
  onCreate: (type: {
    measurementKey: string;
    displayName: string;
    unitConstraint: MeasurementType["unitConstraint"];
    defaultUnit: MeasurementType["defaultUnit"];
    sortOrder?: number;
  }) => void;
  onArchiveToggle: (type: MeasurementType, archived: boolean) => void;
  disabled: boolean;
  serverError: string | null;
};

const CONSTRAINT_OPTIONS: { value: MeasurementType["unitConstraint"]; label: string }[] = [
  { value: "mass", label: "質量（kg / lb）" },
  { value: "percent", label: "割合（%）" },
  { value: "index", label: "無次元指標" },
  { value: "length", label: "長さ（cm / inch）" },
  { value: "custom", label: "単位なしカスタム" },
];

export function TypeManager({
  activeTypes,
  archivedTypes,
  onCreate,
  onArchiveToggle,
  disabled,
  serverError,
}: TypeManagerProps) {
  const [measurementKey, setMeasurementKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [unitConstraint, setUnitConstraint] = useState<MeasurementType["unitConstraint"]>("custom");
  const [defaultUnit, setDefaultUnit] = useState<MeasurementType["defaultUnit"]>("custom");
  const [sortOrder, setSortOrder] = useState<string>("");
  const [errors, setErrors] = useState<
    Partial<Record<"measurementKey" | "displayName" | "defaultUnit", string>>
  >({});

  const keyId = useId();
  const nameId = useId();
  const constraintId = useId();
  const unitId = useId();
  const sortId = useId();

  const allowedUnits = useMemo(() => [...UNITS_BY_CONSTRAINT[unitConstraint]], [unitConstraint]);

  const handleConstraintChange = (value: MeasurementType["unitConstraint"]) => {
    setUnitConstraint(value);
    setDefaultUnit(UNITS_BY_CONSTRAINT[value][0]);
  };

  const validate = (): boolean => {
    const nextErrors: typeof errors = {};
    if (!MEASUREMENT_KEY_PATTERN.test(measurementKey)) {
      nextErrors.measurementKey =
        "項目キーは英小文字で始まり、2〜50文字の英小文字・数字・アンダースコアにしてください。";
    } else if (isDefaultMeasurementKey(measurementKey)) {
      nextErrors.measurementKey = "この項目キーは既定種別で予約されています。";
    }
    if (!displayName.trim()) {
      nextErrors.displayName = "表示名を入力してください。";
    } else if (displayName.length > 100) {
      nextErrors.displayName = "表示名は100文字以内で入力してください。";
    }
    if (!isUnitAllowedFor(unitConstraint, defaultUnit)) {
      nextErrors.defaultUnit = "選択した単位制約に合う単位を選んでください。";
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    onCreate({
      measurementKey,
      displayName: displayName.trim(),
      unitConstraint,
      defaultUnit,
      sortOrder: sortOrder.trim() ? Number(sortOrder) : undefined,
    });
    setMeasurementKey("");
    setDisplayName("");
    setUnitConstraint("custom");
    setDefaultUnit("custom");
    setSortOrder("");
    setErrors({});
  };

  return (
    <div>
      <section className={styles.card} aria-labelledby="active-types-heading">
        <h2 className={styles.sectionTitle} id="active-types-heading">
          測定種別一覧
        </h2>
        {serverError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {serverError}
          </p>
        ) : null}
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">表示名</th>
                <th scope="col">項目キー</th>
                <th scope="col">単位制約</th>
                <th scope="col">既定単位</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {activeTypes.map((type) => (
                <tr key={type.id} className={type.archivedAt ? styles.archived : undefined}>
                  <td>
                    {type.displayName}
                    {type.isDefault ? <span className={styles.typeDefault}>（既定）</span> : null}
                  </td>
                  <td>{type.measurementKey}</td>
                  <td>{type.unitConstraint}</td>
                  <td>{type.defaultUnit}</td>
                  <td>
                    {type.isDefault ? (
                      <span className={styles.typeDefault}>編集不可</span>
                    ) : (
                      <button
                        className={`${styles.button} ${styles.buttonDanger}`}
                        type="button"
                        onClick={() => onArchiveToggle(type, true)}
                        disabled={disabled}
                      >
                        アーカイブ
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {archivedTypes.length > 0 ? (
        <section className={styles.card} aria-labelledby="archived-types-heading">
          <h2 className={styles.sectionTitle} id="archived-types-heading">
            アーカイブ済み種別
          </h2>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">表示名</th>
                  <th scope="col">項目キー</th>
                  <th scope="col">アーカイブ日時</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {archivedTypes.map((type) => (
                  <tr key={type.id} className={styles.archived}>
                    <td>{type.displayName}</td>
                    <td>{type.measurementKey}</td>
                    <td>{type.archivedAt ? new Date(type.archivedAt).toLocaleString() : "—"}</td>
                    <td>
                      <button
                        className={`${styles.button} ${styles.buttonSecondary}`}
                        type="button"
                        onClick={() => onArchiveToggle(type, false)}
                        disabled={disabled}
                      >
                        解除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className={styles.card} aria-labelledby="new-type-heading">
        <h2 className={styles.sectionTitle} id="new-type-heading">
          カスタム種別を追加
        </h2>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={keyId}>
                項目キー
              </label>
              <input
                id={keyId}
                className={styles.input}
                type="text"
                value={measurementKey}
                onChange={(event) => setMeasurementKey(event.target.value)}
                disabled={disabled}
                aria-invalid={Boolean(errors.measurementKey)}
                aria-describedby={errors.measurementKey ? `${keyId}-error` : undefined}
              />
              {errors.measurementKey ? (
                <p className={styles.fieldError} id={`${keyId}-error`}>
                  {errors.measurementKey}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={nameId}>
                表示名
              </label>
              <input
                id={nameId}
                className={styles.input}
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={disabled}
                aria-invalid={Boolean(errors.displayName)}
                aria-describedby={errors.displayName ? `${nameId}-error` : undefined}
              />
              {errors.displayName ? (
                <p className={styles.fieldError} id={`${nameId}-error`}>
                  {errors.displayName}
                </p>
              ) : null}
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={constraintId}>
                単位制約
              </label>
              <select
                id={constraintId}
                className={styles.select}
                value={unitConstraint}
                onChange={(event) =>
                  handleConstraintChange(event.target.value as MeasurementType["unitConstraint"])
                }
                disabled={disabled}
              >
                {CONSTRAINT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={unitId}>
                既定単位
              </label>
              <select
                id={unitId}
                className={styles.select}
                value={defaultUnit}
                onChange={(event) =>
                  setDefaultUnit(event.target.value as MeasurementType["defaultUnit"])
                }
                disabled={disabled}
                aria-invalid={Boolean(errors.defaultUnit)}
                aria-describedby={errors.defaultUnit ? `${unitId}-error` : undefined}
              >
                {allowedUnits.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
              {errors.defaultUnit ? (
                <p className={styles.fieldError} id={`${unitId}-error`}>
                  {errors.defaultUnit}
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={sortId}>
                並び順
              </label>
              <input
                id={sortId}
                className={styles.input}
                type="number"
                min={0}
                max={100000}
                value={sortOrder}
                placeholder="1000"
                onChange={(event) => setSortOrder(event.target.value)}
                disabled={disabled}
              />
            </div>
          </div>

          <button className={styles.button} type="submit" disabled={disabled}>
            {disabled ? "送信中…" : "追加する"}
          </button>
        </form>
      </section>
    </div>
  );
}

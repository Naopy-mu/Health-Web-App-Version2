"use client";

import { useId, useState } from "react";

import type { BeverageType, SymptomType } from "../schema";
import { CUSTOM_SYMPTOM_TYPE_MAX, isDefaultBeverageKey, isDefaultSymptomKey } from "../defaults";
import { HYDRATION_UNITS, type HydrationUnit } from "../units";
import { activeCustomSymptomCount } from "../utils";
import type { ConflictInfo } from "../use-wellness";
import { ConflictBanner } from "./conflict-banner";
import styles from "../wellness.module.css";

type TypeManagerProps = {
  resource: "hydration" | "condition";
  activeTypes: (BeverageType | SymptomType)[];
  archivedTypes: (BeverageType | SymptomType)[];
  onCreate: (type: {
    key: string;
    displayName: string;
    defaultUnit?: HydrationUnit;
    defaultAmount?: number | null;
    containsCaffeine?: boolean;
    containsAlcohol?: boolean;
    sortOrder?: number;
  }) => Promise<boolean> | boolean;
  onArchiveToggle: (
    type: BeverageType | SymptomType,
    archived: boolean,
  ) => Promise<boolean> | boolean;
  disabled: boolean;
  serverError: string | null;
  conflict?: ConflictInfo | null;
};

const TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

export function TypeManager({
  resource,
  activeTypes: active,
  archivedTypes,
  onCreate,
  onArchiveToggle,
  disabled,
  serverError,
  conflict,
}: TypeManagerProps) {
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [defaultUnit, setDefaultUnit] = useState<HydrationUnit>("ml");
  const [defaultAmount, setDefaultAmount] = useState<string>("");
  const [containsCaffeine, setContainsCaffeine] = useState(false);
  const [containsAlcohol, setContainsAlcohol] = useState(false);
  const [sortOrder, setSortOrder] = useState<string>("");
  const [errors, setErrors] = useState<
    Partial<Record<"key" | "displayName" | "defaultUnit", string>>
  >({});

  const keyId = useId();
  const nameId = useId();
  const unitId = useId();
  const amountId = useId();
  const caffeineId = useId();
  const alcoholId = useId();
  const sortId = useId();

  const isBeverage = resource === "hydration";
  const customActiveCount = isBeverage ? 0 : activeCustomSymptomCount(active as SymptomType[]);
  const atLimit = !isBeverage && customActiveCount >= CUSTOM_SYMPTOM_TYPE_MAX;

  const validate = (): boolean => {
    const nextErrors: typeof errors = {};
    if (!TYPE_KEY_PATTERN.test(key)) {
      nextErrors.key =
        "項目キーは英小文字で始まり、2〜50文字の英小文字・数字・アンダースコアにしてください。";
    } else if (isBeverage ? isDefaultBeverageKey(key) : isDefaultSymptomKey(key)) {
      nextErrors.key = "この項目キーは既定種別で予約されています。";
    }
    if (!displayName.trim()) {
      nextErrors.displayName = "表示名を入力してください。";
    } else if (displayName.length > 100) {
      nextErrors.displayName = "表示名は100文字以内で入力してください。";
    }
    if (isBeverage && !HYDRATION_UNITS.includes(defaultUnit as never)) {
      nextErrors.defaultUnit = "単位を選んでください。";
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const resetForm = () => {
    setKey("");
    setDisplayName("");
    setDefaultUnit("ml");
    setDefaultAmount("");
    setContainsCaffeine(false);
    setContainsAlcohol(false);
    setSortOrder("");
    setErrors({});
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    const amount = defaultAmount.trim() ? Number(defaultAmount) : null;
    const ok = await onCreate({
      key,
      displayName: displayName.trim(),
      ...(isBeverage
        ? {
            defaultUnit,
            defaultAmount: amount !== null && Number.isFinite(amount) && amount > 0 ? amount : null,
            containsCaffeine,
            containsAlcohol,
          }
        : {}),
      sortOrder: sortOrder.trim() ? Number(sortOrder) : undefined,
    });
    if (ok) {
      resetForm();
    }
  };

  const title = isBeverage ? "飲み物種別" : "症状種別";

  return (
    <div>
      <section className={styles.card} aria-labelledby="active-types-heading">
        <h2 className={styles.sectionTitle} id="active-types-heading">
          {title}一覧
        </h2>
        {serverError ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {serverError}
          </p>
        ) : null}
        {conflict ? <ConflictBanner conflict={conflict} /> : null}
        {!isBeverage && atLimit ? (
          <p className={styles.limitBanner} role="alert">
            カスタム症状種別は{CUSTOM_SYMPTOM_TYPE_MAX}
            件までです。新しく追加するには既存のカスタム症状をアーカイブしてください。
          </p>
        ) : null}
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">表示名</th>
                <th scope="col">項目キー</th>
                {isBeverage ? <th scope="col">既定単位</th> : null}
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {active.map((type) => (
                <tr key={type.id}>
                  <td>
                    {type.displayName}
                    {type.isDefault ? <span className={styles.typeDefault}>（既定）</span> : null}
                  </td>
                  <td>{"beverageKey" in type ? type.beverageKey : type.symptomKey}</td>
                  {isBeverage ? <td>{(type as BeverageType).defaultUnit}</td> : null}
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
            アーカイブ済み{title}
          </h2>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">表示名</th>
                  <th scope="col">項目キー</th>
                  {isBeverage ? <th scope="col">既定単位</th> : null}
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {archivedTypes.map((type) => (
                  <tr key={type.id} className={styles.archived}>
                    <td>{type.displayName}</td>
                    <td>{"beverageKey" in type ? type.beverageKey : type.symptomKey}</td>
                    {isBeverage ? <td>{(type as BeverageType).defaultUnit}</td> : null}
                    <td>
                      <button
                        className={`${styles.button} ${styles.buttonSecondary}`}
                        type="button"
                        onClick={() => onArchiveToggle(type, false)}
                        disabled={disabled || (!isBeverage && atLimit)}
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
          カスタム{title}を追加
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
                value={key}
                onChange={(event) => setKey(event.target.value)}
                disabled={disabled || (!isBeverage && atLimit)}
                aria-invalid={Boolean(errors.key)}
                aria-describedby={errors.key ? `${keyId}-error` : undefined}
              />
              {errors.key ? (
                <p className={styles.fieldError} id={`${keyId}-error`}>
                  {errors.key}
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
                disabled={disabled || (!isBeverage && atLimit)}
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

          {isBeverage ? (
            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={unitId}>
                  既定単位
                </label>
                <select
                  id={unitId}
                  className={styles.select}
                  value={defaultUnit}
                  onChange={(event) => setDefaultUnit(event.target.value as HydrationUnit)}
                  disabled={disabled}
                  aria-invalid={Boolean(errors.defaultUnit)}
                  aria-describedby={errors.defaultUnit ? `${unitId}-error` : undefined}
                >
                  {HYDRATION_UNITS.map((unit) => (
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
                <label className={styles.label} htmlFor={amountId}>
                  既定量（任意）
                </label>
                <input
                  id={amountId}
                  className={styles.input}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={defaultAmount}
                  onChange={(event) => setDefaultAmount(event.target.value)}
                  disabled={disabled}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={sortId}>
                  並び順（任意）
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
          ) : null}

          {isBeverage ? (
            <div className={styles.row}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={caffeineId}>
                  <input
                    id={caffeineId}
                    className={styles.checkbox}
                    type="checkbox"
                    checked={containsCaffeine}
                    onChange={(event) => setContainsCaffeine(event.target.checked)}
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
                    checked={containsAlcohol}
                    onChange={(event) => setContainsAlcohol(event.target.checked)}
                    disabled={disabled}
                  />{" "}
                  アルコールを含む
                </label>
              </div>
            </div>
          ) : null}

          {!isBeverage ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={sortId}>
                並び順（任意）
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
                disabled={disabled || atLimit}
              />
            </div>
          ) : null}

          <button
            className={styles.button}
            type="submit"
            disabled={disabled || (!isBeverage && atLimit)}
          >
            {disabled ? "送信中…" : "追加する"}
          </button>
        </form>
      </section>
    </div>
  );
}

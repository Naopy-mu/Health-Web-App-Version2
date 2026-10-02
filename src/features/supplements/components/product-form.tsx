"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { SupplementProduct } from "../schema";
import {
  SUPPLEMENT_CATEGORIES,
  SUPPLEMENT_FORMS,
  SUPPLEMENT_UNITS,
  type SupplementCategory,
  type SupplementForm,
  type SupplementUnit,
} from "../units";
import { normalizeSupplementName } from "../units";
import { categoryLabel, formLabel, unitLabel } from "../labels";
import styles from "./supplements.module.css";

type ProductFormData = {
  productKey: string;
  name: string;
  brand: string;
  category: SupplementCategory;
  form: SupplementForm;
  defaultAmount: string;
  defaultUnit: SupplementUnit;
  amountPerContainer: string;
  lowStockThreshold: string;
  ingredientNote: string;
  safetyNote: string;
  url: string;
  archived: boolean;
};

function emptyForm(): ProductFormData {
  return {
    productKey: "",
    name: "",
    brand: "",
    category: "vitamin",
    form: "tablet",
    defaultAmount: "",
    defaultUnit: "tablet",
    amountPerContainer: "",
    lowStockThreshold: "",
    ingredientNote: "",
    safetyNote: "",
    url: "",
    archived: false,
  };
}

function entryToForm(entry: SupplementProduct): ProductFormData {
  return {
    productKey: entry.productKey,
    name: entry.name,
    brand: entry.brand ?? "",
    category: entry.category,
    form: entry.form,
    defaultAmount: entry.defaultAmount === null ? "" : String(entry.defaultAmount),
    defaultUnit: entry.defaultUnit,
    amountPerContainer: entry.amountPerContainer === null ? "" : String(entry.amountPerContainer),
    lowStockThreshold: entry.lowStockThreshold === null ? "" : String(entry.lowStockThreshold),
    ingredientNote: entry.ingredientNote ?? "",
    safetyNote: entry.safetyNote ?? "",
    url: entry.url ?? "",
    archived: entry.archivedAt !== null,
  };
}

type ProductFormProps = {
  products: SupplementProduct[];
  editingProduct: SupplementProduct | null;
  productIdsWithLots: Set<string>;
  onSubmit: (input: {
    id?: string;
    expectedRowVersion?: number;
    productKey?: string;
    name: string;
    brand: string | null;
    category: SupplementCategory;
    form: SupplementForm;
    defaultAmount: number | null;
    defaultUnit: SupplementUnit;
    amountPerContainer: number | null;
    lowStockThreshold: number | null;
    ingredientNote: string | null;
    safetyNote: string | null;
    url: string | null;
    archived: boolean;
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function ProductForm({
  products,
  editingProduct,
  productIdsWithLots,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: ProductFormProps) {
  const [form, setForm] = useState<ProductFormData>(() => emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ProductFormData, string>>>(
    {},
  );

  const keyId = useId();
  const nameId = useId();
  const brandId = useId();
  const categoryId = useId();
  const formId = useId();
  const defaultAmountId = useId();
  const defaultUnitId = useId();
  const amountPerContainerId = useId();
  const lowStockThresholdId = useId();
  const ingredientNoteId = useId();
  const safetyNoteId = useId();
  const urlId = useId();

  const previousEditingId = useRef<string | null>(null);

  const unitLocked = Boolean(editingProduct && productIdsWithLots.has(editingProduct.id));

  useEffect(() => {
    const editingId = editingProduct?.id ?? null;
    if (editingId === previousEditingId.current) {
      return;
    }
    previousEditingId.current = editingId;
    setForm(editingProduct ? entryToForm(editingProduct) : emptyForm());
    setFieldErrors({});
  }, [editingProduct]);

  const handleChange = (field: keyof ProductFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const parseOptionalNumber = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    const num = Number(trimmed);
    if (Number.isNaN(num)) {
      return null;
    }
    return num;
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof ProductFormData, string>> = {};

    if (!editingProduct) {
      if (!form.productKey) {
        errors.productKey = "商品キーを入力してください。";
      } else if (!/^[a-z][a-z0-9_]{1,49}$/.test(form.productKey)) {
        errors.productKey =
          "商品キーは英小文字で始まり、英小文字・数字・アンダースコアで2〜50文字にしてください。";
      }
    }

    if (!form.name.trim()) {
      errors.name = "商品名を入力してください。";
    } else if (form.name.length > 200) {
      errors.name = "商品名は200文字以内で入力してください。";
    } else {
      const normalized = normalizeSupplementName(form.name);
      const duplicate = products.find(
        (p) =>
          p.id !== editingProduct?.id &&
          (p.nameNormalized === normalized || p.productKey === form.productKey),
      );
      if (duplicate) {
        errors.name = `「${duplicate.name}」と同じ名前またはキーの商品が既に存在します。`;
      }
    }

    if (form.brand.length > 100) {
      errors.brand = "ブランド名は100文字以内で入力してください。";
    }

    const defaultAmount = parseOptionalNumber(form.defaultAmount);
    if (form.defaultAmount.trim() !== "" && (defaultAmount === null || defaultAmount <= 0)) {
      errors.defaultAmount = "既定量は0より大きい数値で入力してください。";
    }

    const amountPerContainer = parseOptionalNumber(form.amountPerContainer);
    if (
      form.amountPerContainer.trim() !== "" &&
      (amountPerContainer === null || amountPerContainer <= 0)
    ) {
      errors.amountPerContainer = "容器あたり量は0より大きい数値で入力してください。";
    }

    const lowStockThreshold = parseOptionalNumber(form.lowStockThreshold);
    if (
      form.lowStockThreshold.trim() !== "" &&
      (lowStockThreshold === null || lowStockThreshold < 0)
    ) {
      errors.lowStockThreshold = "低在庫しきい値は0以上で入力してください。";
    }

    if (form.ingredientNote.length > 2000) {
      errors.ingredientNote = "成分メモは2,000文字以内で入力してください。";
    }
    if (form.safetyNote.length > 2000) {
      errors.safetyNote = "安全上の注意は2,000文字以内で入力してください。";
    }
    if (form.url.trim() !== "" && !/^https:\/\/\S+$/.test(form.url)) {
      errors.url = "URLは https:// で始まる形式で入力してください。";
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
      ...(editingProduct
        ? { id: editingProduct.id, expectedRowVersion: editingProduct.rowVersion }
        : { productKey: form.productKey }),
      name: form.name.trim(),
      brand: form.brand.trim() || null,
      category: form.category,
      form: form.form,
      defaultAmount: parseOptionalNumber(form.defaultAmount),
      defaultUnit: form.defaultUnit,
      amountPerContainer: parseOptionalNumber(form.amountPerContainer),
      lowStockThreshold: parseOptionalNumber(form.lowStockThreshold),
      ingredientNote: form.ingredientNote.trim() || null,
      safetyNote: form.safetyNote.trim() || null,
      url: form.url.trim() || null,
      archived: form.archived,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingProduct ? "edit-product-heading" : "new-product-heading"}
    >
      <h2
        className={styles.sectionTitle}
        id={editingProduct ? "edit-product-heading" : "new-product-heading"}
      >
        {editingProduct ? "商品を編集" : "新規商品"}
      </h2>
      {serverError ? (
        <p className={`${styles.status} ${styles.statusError}`} role="alert">
          {serverError}
        </p>
      ) : null}
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={nameId}>
              商品名
            </label>
            <input
              id={nameId}
              className={styles.input}
              type="text"
              value={form.name}
              onChange={(event) => handleChange("name", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? `${nameId}-error` : undefined}
            />
            {fieldErrors.name ? (
              <p className={styles.fieldError} id={`${nameId}-error`}>
                {fieldErrors.name}
              </p>
            ) : null}
          </div>

          {!editingProduct ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={keyId}>
                商品キー
              </label>
              <input
                id={keyId}
                className={styles.input}
                type="text"
                value={form.productKey}
                onChange={(event) => handleChange("productKey", event.target.value)}
                disabled={disabled}
                aria-invalid={Boolean(fieldErrors.productKey)}
                aria-describedby={fieldErrors.productKey ? `${keyId}-error` : undefined}
              />
              {fieldErrors.productKey ? (
                <p className={styles.fieldError} id={`${keyId}-error`}>
                  {fieldErrors.productKey}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={brandId}>
              ブランド（任意）
            </label>
            <input
              id={brandId}
              className={styles.input}
              type="text"
              value={form.brand}
              onChange={(event) => handleChange("brand", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.brand)}
              aria-describedby={fieldErrors.brand ? `${brandId}-error` : undefined}
            />
            {fieldErrors.brand ? (
              <p className={styles.fieldError} id={`${brandId}-error`}>
                {fieldErrors.brand}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={categoryId}>
              カテゴリ
            </label>
            <select
              id={categoryId}
              className={styles.select}
              value={form.category}
              onChange={(event) => handleChange("category", event.target.value)}
              disabled={disabled}
            >
              {SUPPLEMENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {categoryLabel(category)}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={formId}>
              剤形
            </label>
            <select
              id={formId}
              className={styles.select}
              value={form.form}
              onChange={(event) => handleChange("form", event.target.value)}
              disabled={disabled}
            >
              {SUPPLEMENT_FORMS.map((formValue) => (
                <option key={formValue} value={formValue}>
                  {formLabel(formValue)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={defaultAmountId}>
              既定量（任意）
            </label>
            <input
              id={defaultAmountId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.defaultAmount}
              onChange={(event) => handleChange("defaultAmount", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.defaultAmount)}
              aria-describedby={fieldErrors.defaultAmount ? `${defaultAmountId}-error` : undefined}
            />
            {fieldErrors.defaultAmount ? (
              <p className={styles.fieldError} id={`${defaultAmountId}-error`}>
                {fieldErrors.defaultAmount}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={defaultUnitId}>
              単位
            </label>
            <select
              id={defaultUnitId}
              className={styles.select}
              value={form.defaultUnit}
              onChange={(event) => handleChange("defaultUnit", event.target.value)}
              disabled={disabled || unitLocked}
              aria-invalid={Boolean(fieldErrors.defaultUnit)}
              aria-describedby={
                fieldErrors.defaultUnit
                  ? `${defaultUnitId}-error`
                  : unitLocked
                    ? `${defaultUnitId}-locked`
                    : undefined
              }
            >
              {SUPPLEMENT_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
            {unitLocked ? (
              <p className={styles.unitLocked} id={`${defaultUnitId}-locked`}>
                在庫ロットが存在するため単位は変更できません。
              </p>
            ) : null}
            {fieldErrors.defaultUnit ? (
              <p className={styles.fieldError} id={`${defaultUnitId}-error`}>
                {fieldErrors.defaultUnit}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={amountPerContainerId}>
              容器あたり量（任意）
            </label>
            <input
              id={amountPerContainerId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.amountPerContainer}
              onChange={(event) => handleChange("amountPerContainer", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.amountPerContainer)}
              aria-describedby={
                fieldErrors.amountPerContainer ? `${amountPerContainerId}-error` : undefined
              }
            />
            {fieldErrors.amountPerContainer ? (
              <p className={styles.fieldError} id={`${amountPerContainerId}-error`}>
                {fieldErrors.amountPerContainer}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={lowStockThresholdId}>
              低在庫しきい値（任意）
            </label>
            <input
              id={lowStockThresholdId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.lowStockThreshold}
              onChange={(event) => handleChange("lowStockThreshold", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.lowStockThreshold)}
              aria-describedby={
                fieldErrors.lowStockThreshold ? `${lowStockThresholdId}-error` : undefined
              }
            />
            {fieldErrors.lowStockThreshold ? (
              <p className={styles.fieldError} id={`${lowStockThresholdId}-error`}>
                {fieldErrors.lowStockThreshold}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={ingredientNoteId}>
            成分メモ（任意）
          </label>
          <textarea
            id={ingredientNoteId}
            className={styles.textarea}
            maxLength={2000}
            value={form.ingredientNote}
            onChange={(event) => handleChange("ingredientNote", event.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(fieldErrors.ingredientNote)}
            aria-describedby={fieldErrors.ingredientNote ? `${ingredientNoteId}-error` : undefined}
          />
          {fieldErrors.ingredientNote ? (
            <p className={styles.fieldError} id={`${ingredientNoteId}-error`}>
              {fieldErrors.ingredientNote}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={safetyNoteId}>
            安全上の注意（任意）
          </label>
          <textarea
            id={safetyNoteId}
            className={styles.textarea}
            maxLength={2000}
            value={form.safetyNote}
            onChange={(event) => handleChange("safetyNote", event.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(fieldErrors.safetyNote)}
            aria-describedby={fieldErrors.safetyNote ? `${safetyNoteId}-error` : undefined}
          />
          {fieldErrors.safetyNote ? (
            <p className={styles.fieldError} id={`${safetyNoteId}-error`}>
              {fieldErrors.safetyNote}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={urlId}>
            URL（任意）
          </label>
          <input
            id={urlId}
            className={styles.input}
            type="url"
            value={form.url}
            onChange={(event) => handleChange("url", event.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(fieldErrors.url)}
            aria-describedby={fieldErrors.url ? `${urlId}-error` : undefined}
          />
          {fieldErrors.url ? (
            <p className={styles.fieldError} id={`${urlId}-error`}>
              {fieldErrors.url}
            </p>
          ) : null}
        </div>

        {editingProduct ? (
          <div className={styles.field}>
            <label className={styles.label}>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={form.archived}
                onChange={(event) => handleChange("archived", event.target.checked)}
                disabled={disabled}
              />{" "}
              アーカイブ済み
            </label>
          </div>
        ) : null}

        <div className={styles.buttonGroup}>
          <button className={styles.button} type="submit" disabled={disabled}>
            {disabled ? "送信中…" : editingProduct ? "更新する" : "登録する"}
          </button>
          {editingProduct ? (
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

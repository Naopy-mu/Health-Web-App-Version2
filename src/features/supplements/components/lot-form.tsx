"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { SupplementLot, SupplementProduct } from "../schema";
import styles from "./supplements.module.css";

type LotFormData = {
  productId: string;
  lotCode: string;
  quantity: string;
  remainingQuantity: string;
  purchasedOn: string;
  openedOn: string;
  expiresOn: string;
  note: string;
};

function emptyForm(defaultProductId: string): LotFormData {
  return {
    productId: defaultProductId,
    lotCode: "",
    quantity: "",
    remainingQuantity: "",
    purchasedOn: "",
    openedOn: "",
    expiresOn: "",
    note: "",
  };
}

function entryToForm(entry: SupplementLot): LotFormData {
  return {
    productId: entry.productId,
    lotCode: entry.lotCode ?? "",
    quantity: String(entry.quantity),
    remainingQuantity: String(entry.remainingQuantity),
    purchasedOn: entry.purchasedOn ?? "",
    openedOn: entry.openedOn ?? "",
    expiresOn: entry.expiresOn ?? "",
    note: entry.note ?? "",
  };
}

type LotFormProps = {
  products: SupplementProduct[];
  editingLot: SupplementLot | null;
  onSubmit: (input: {
    id?: string;
    expectedRowVersion?: number;
    productId: string;
    lotCode: string | null;
    quantity: number;
    remainingQuantity?: number;
    purchasedOn: string | null;
    openedOn: string | null;
    expiresOn: string | null;
    note: string | null;
  }) => void;
  onCancel: () => void;
  disabled: boolean;
  serverError: string | null;
};

export function LotForm({
  products,
  editingLot,
  onSubmit,
  onCancel,
  disabled,
  serverError,
}: LotFormProps) {
  const [form, setForm] = useState<LotFormData>(() =>
    emptyForm(products.find((p) => p.archivedAt === null)?.id ?? ""),
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof LotFormData, string>>>({});
  const [remainingQuantityTouched, setRemainingQuantityTouched] = useState(false);

  const productId = useId();
  const lotCodeId = useId();
  const quantityId = useId();
  const remainingQuantityId = useId();
  const purchasedOnId = useId();
  const openedOnId = useId();
  const expiresOnId = useId();
  const noteId = useId();

  const previousEditingKey = useRef<string | null>(null);

  const selectedProduct = products.find((p) => p.id === form.productId);
  const isArchived = selectedProduct?.archivedAt !== null;

  useEffect(() => {
    const editingKey = editingLot ? `${editingLot.id}:${editingLot.rowVersion}` : null;
    if (editingKey === previousEditingKey.current) {
      return;
    }
    previousEditingKey.current = editingKey;
    setRemainingQuantityTouched(false);
    setForm(editingLot ? entryToForm(editingLot) : emptyForm(products[0]?.id ?? ""));
    setFieldErrors({});
  }, [editingLot, products]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!form.productId && products.length > 0) {
      const firstActive = products.find((p) => p.archivedAt === null);
      setForm((prev) => ({ ...prev, productId: firstActive?.id ?? products[0]?.id ?? "" }));
    }
  }, [products, form.productId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChange = (field: keyof LotFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    if (field === "remainingQuantity") {
      setRemainingQuantityTouched(true);
    }
  };

  const parseOptionalNumber = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    const num = Number(trimmed);
    return Number.isNaN(num) ? null : num;
  };

  const validate = (): boolean => {
    const errors: Partial<Record<keyof LotFormData, string>> = {};

    if (!form.productId) {
      errors.productId = "商品を選んでください。";
    } else if (isArchived) {
      errors.productId = "アーカイブ済みの商品には在庫を登録できません。";
    }

    if (form.lotCode.trim().length > 50) {
      errors.lotCode = "ロット名は50文字以内で入力してください。";
    }

    const quantity = parseOptionalNumber(form.quantity);
    if (quantity === null || quantity <= 0) {
      errors.quantity = "数量は0より大きい数値で入力してください。";
    }

    const remainingQuantity = parseOptionalNumber(form.remainingQuantity);
    if (
      form.remainingQuantity.trim() !== "" &&
      (remainingQuantity === null ||
        remainingQuantity < 0 ||
        (quantity !== null && remainingQuantity > quantity))
    ) {
      errors.remainingQuantity = "残量は0以上、数量以下で入力してください。";
    }

    if (form.openedOn && form.purchasedOn && form.openedOn < form.purchasedOn) {
      errors.openedOn = "開封日は購入日以降にしてください。";
    }
    if (form.expiresOn && form.purchasedOn && form.expiresOn < form.purchasedOn) {
      errors.expiresOn = "使用期限は購入日以降にしてください。";
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
      ...(editingLot ? { id: editingLot.id, expectedRowVersion: editingLot.rowVersion } : {}),
      productId: form.productId,
      lotCode: form.lotCode.trim() || null,
      quantity: Number(form.quantity),
      ...(remainingQuantityTouched && form.remainingQuantity.trim() !== ""
        ? { remainingQuantity: Number(form.remainingQuantity) }
        : {}),
      purchasedOn: form.purchasedOn || null,
      openedOn: form.openedOn || null,
      expiresOn: form.expiresOn || null,
      note: form.note.trim() || null,
    });
  };

  return (
    <section
      className={styles.card}
      aria-labelledby={editingLot ? "edit-lot-heading" : "new-lot-heading"}
    >
      <h2 className={styles.sectionTitle} id={editingLot ? "edit-lot-heading" : "new-lot-heading"}>
        {editingLot ? "在庫ロットを編集" : "新規在庫ロット"}
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
              disabled={disabled || editingLot !== null}
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
            <label className={styles.label} htmlFor={lotCodeId}>
              ロット名（任意）
            </label>
            <input
              id={lotCodeId}
              className={styles.input}
              type="text"
              value={form.lotCode}
              onChange={(event) => handleChange("lotCode", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.lotCode)}
              aria-describedby={fieldErrors.lotCode ? `${lotCodeId}-error` : undefined}
            />
            {fieldErrors.lotCode ? (
              <p className={styles.fieldError} id={`${lotCodeId}-error`}>
                {fieldErrors.lotCode}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={quantityId}>
              数量
            </label>
            <input
              id={quantityId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.quantity}
              onChange={(event) => handleChange("quantity", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.quantity)}
              aria-describedby={fieldErrors.quantity ? `${quantityId}-error` : undefined}
            />
            {fieldErrors.quantity ? (
              <p className={styles.fieldError} id={`${quantityId}-error`}>
                {fieldErrors.quantity}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={remainingQuantityId}>
              残量（空欄で数量と同じ）
            </label>
            <input
              id={remainingQuantityId}
              className={styles.input}
              type="number"
              step="any"
              inputMode="decimal"
              value={form.remainingQuantity}
              onChange={(event) => handleChange("remainingQuantity", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.remainingQuantity)}
              aria-describedby={
                fieldErrors.remainingQuantity ? `${remainingQuantityId}-error` : undefined
              }
            />
            {fieldErrors.remainingQuantity ? (
              <p className={styles.fieldError} id={`${remainingQuantityId}-error`}>
                {fieldErrors.remainingQuantity}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={purchasedOnId}>
              購入日（任意）
            </label>
            <input
              id={purchasedOnId}
              className={styles.input}
              type="date"
              value={form.purchasedOn}
              onChange={(event) => handleChange("purchasedOn", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.purchasedOn)}
              aria-describedby={fieldErrors.purchasedOn ? `${purchasedOnId}-error` : undefined}
            />
            {fieldErrors.purchasedOn ? (
              <p className={styles.fieldError} id={`${purchasedOnId}-error`}>
                {fieldErrors.purchasedOn}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={openedOnId}>
              開封日（任意）
            </label>
            <input
              id={openedOnId}
              className={styles.input}
              type="date"
              value={form.openedOn}
              onChange={(event) => handleChange("openedOn", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.openedOn)}
              aria-describedby={fieldErrors.openedOn ? `${openedOnId}-error` : undefined}
            />
            {fieldErrors.openedOn ? (
              <p className={styles.fieldError} id={`${openedOnId}-error`}>
                {fieldErrors.openedOn}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={expiresOnId}>
              使用期限（任意）
            </label>
            <input
              id={expiresOnId}
              className={styles.input}
              type="date"
              value={form.expiresOn}
              onChange={(event) => handleChange("expiresOn", event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldErrors.expiresOn)}
              aria-describedby={fieldErrors.expiresOn ? `${expiresOnId}-error` : undefined}
            />
            {fieldErrors.expiresOn ? (
              <p className={styles.fieldError} id={`${expiresOnId}-error`}>
                {fieldErrors.expiresOn}
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
            {disabled ? "送信中…" : editingLot ? "更新する" : "登録する"}
          </button>
          {editingLot ? (
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SupplementLot, SupplementProduct } from "../schema";
import { useSupplements } from "../use-supplements";
import { generateUuid } from "../utils";
import { ProductForm } from "./product-form";
import { ProductList } from "./product-list";
import { ConflictBanner } from "./conflict-banner";
import { SupplementSubnav } from "./supplement-subnav";
import styles from "./supplements.module.css";

export function ProductPage() {
  const [editingProduct, setEditingProduct] = useState<SupplementProduct | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const mutationIdRef = useRef<string | null>(null);

  const {
    entries,
    products,
    activeProducts,
    archivedProducts,
    loadingState,
    error,
    conflict,
    saveProduct,
  } = useSupplements<SupplementLot>("lot");

  useEffect(() => {
    if (conflict) {
      conflictRef.current?.focus();
    }
  }, [conflict]);

  const productIdsWithLots = useMemo(
    () => new Set((entries as SupplementLot[]).map((lot) => lot.productId)),
    [entries],
  );

  const getMutationId = useCallback(() => {
    if (!mutationIdRef.current) {
      mutationIdRef.current = generateUuid();
    }
    return mutationIdRef.current;
  }, []);

  const clearMutationId = useCallback(() => {
    mutationIdRef.current = null;
  }, []);

  const handleSave = useCallback(
    async (input: {
      id?: string;
      expectedRowVersion?: number;
      productKey?: string;
      name: string;
      brand: string | null;
      category: import("../units").SupplementCategory;
      form: import("../units").SupplementForm;
      defaultAmount: number | null;
      defaultUnit: import("../units").SupplementUnit;
      amountPerContainer: number | null;
      lowStockThreshold: number | null;
      ingredientNote: string | null;
      safetyNote: string | null;
      url: string | null;
      archived: boolean;
    }) => {
      const request = {
        resource: "product" as const,
        clientMutationId: getMutationId(),
        product: input,
      };
      const ok = await saveProduct(request, { editingProduct, setEditingProduct });
      if (ok) {
        setEditingProduct(null);
        clearMutationId();
      }
      return ok;
    },
    [saveProduct, editingProduct, getMutationId, clearMutationId],
  );

  const handleArchiveToggle = useCallback(
    async (product: SupplementProduct, archived: boolean) => {
      const request = {
        resource: "product" as const,
        clientMutationId: generateUuid(),
        product: {
          id: product.id,
          expectedRowVersion: product.rowVersion,
          name: product.name,
          category: product.category,
          form: product.form,
          defaultUnit: product.defaultUnit,
          archived,
        },
      };
      return saveProduct(request, { editingProduct, setEditingProduct });
    },
    [saveProduct, editingProduct],
  );

  const isLoading = loadingState !== "idle";
  const isSubmitting = loadingState === "submitting";

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>サプリメント 商品管理</h1>
        </header>

        <SupplementSubnav current="/supplements/products" />

        {error ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {error}
          </p>
        ) : null}
        {isLoading && !isSubmitting ? (
          <p className={`${styles.status} ${styles.statusInfo}`} role="status">
            読み込み中…
          </p>
        ) : null}

        {conflict ? <ConflictBanner ref={conflictRef} conflict={conflict} /> : null}

        <ProductForm
          products={products}
          editingProduct={editingProduct}
          productIdsWithLots={productIdsWithLots}
          onSubmit={handleSave}
          onCancel={() => {
            setEditingProduct(null);
            clearMutationId();
          }}
          disabled={isSubmitting}
          serverError={error}
        />

        <section className={styles.card} aria-labelledby="active-product-list-heading">
          <h2 className={styles.sectionTitle} id="active-product-list-heading">
            商品一覧
          </h2>
          <ProductList
            products={activeProducts}
            productIdsWithLots={productIdsWithLots}
            onEdit={setEditingProduct}
            onArchiveToggle={handleArchiveToggle}
            disabled={isSubmitting}
          />
        </section>

        {archivedProducts.length > 0 ? (
          <section className={styles.card} aria-labelledby="archived-product-list-heading">
            <h2 className={styles.sectionTitle} id="archived-product-list-heading">
              アーカイブ済み商品
            </h2>
            <ProductList
              products={archivedProducts}
              productIdsWithLots={productIdsWithLots}
              onEdit={setEditingProduct}
              onArchiveToggle={handleArchiveToggle}
              disabled={isSubmitting}
            />
          </section>
        ) : null}
      </div>
    </main>
  );
}

/**
 * サプリメント関連の表示ラベル（日本語）。
 *
 * DB・API は英語の識別子だけを扱うため、画面側で変換する。
 */

import {
  SUPPLEMENT_CATEGORIES,
  SUPPLEMENT_FORMS,
  SUPPLEMENT_MEAL_RELATIONS,
  SUPPLEMENT_SCHEDULE_KINDS,
  SUPPLEMENT_UNITS,
  type SupplementCategory,
  type SupplementForm,
  type SupplementMealRelation,
  type SupplementScheduleKind,
  type SupplementUnit,
} from "./units";

export const SUPPLEMENT_CATEGORY_LABELS: Record<SupplementCategory, string> = {
  vitamin: "ビタミン",
  mineral: "ミネラル",
  protein: "プロテイン",
  amino_acid: "アミノ酸",
  fiber: "食物繊維",
  probiotic: "プロバイオティクス",
  botanical: "植物性",
  other: "その他",
};

export const SUPPLEMENT_FORM_LABELS: Record<SupplementForm, string> = {
  tablet: "錠剤",
  capsule: "カプセル",
  powder: "粉末",
  liquid: "液体",
  gummy: "グミ",
  granule: "顆粒",
  other: "その他",
};

export const SUPPLEMENT_UNIT_LABELS: Record<SupplementUnit, string> = {
  tablet: "錠",
  capsule: "カプセル",
  gummy: "グミ",
  sachet: "包",
  scoop: "スクープ",
  drop: "滴",
  piece: "個",
  g: "g",
  mg: "mg",
  mcg: "μg",
  ml: "ml",
};

export const SUPPLEMENT_SCHEDULE_KIND_LABELS: Record<SupplementScheduleKind, string> = {
  once: "単発",
  daily: "毎日",
  weekly: "週次",
  as_needed: "必要時",
};

export const SUPPLEMENT_MEAL_RELATION_LABELS: Record<SupplementMealRelation, string> = {
  unspecified: "指定なし",
  before_meal: "食前",
  with_meal: "食中",
  after_meal: "食後",
  as_labeled: "表示に従う",
};

export function categoryLabel(category: SupplementCategory): string {
  return SUPPLEMENT_CATEGORY_LABELS[category];
}

export function formLabel(form: SupplementForm): string {
  return SUPPLEMENT_FORM_LABELS[form];
}

export function unitLabel(unit: SupplementUnit): string {
  return SUPPLEMENT_UNIT_LABELS[unit];
}

export function scheduleKindLabel(kind: SupplementScheduleKind): string {
  return SUPPLEMENT_SCHEDULE_KIND_LABELS[kind];
}

export function mealRelationLabel(relation: SupplementMealRelation): string {
  return SUPPLEMENT_MEAL_RELATION_LABELS[relation];
}

export const SUPPLEMENT_CATEGORIES_WITH_LABELS = SUPPLEMENT_CATEGORIES.map((value) => ({
  value,
  label: SUPPLEMENT_CATEGORY_LABELS[value],
}));

export const SUPPLEMENT_FORMS_WITH_LABELS = SUPPLEMENT_FORMS.map((value) => ({
  value,
  label: SUPPLEMENT_FORM_LABELS[value],
}));

export const SUPPLEMENT_UNITS_WITH_LABELS = SUPPLEMENT_UNITS.map((value) => ({
  value,
  label: SUPPLEMENT_UNIT_LABELS[value],
}));

export const SUPPLEMENT_SCHEDULE_KINDS_WITH_LABELS = SUPPLEMENT_SCHEDULE_KINDS.map((value) => ({
  value,
  label: SUPPLEMENT_SCHEDULE_KIND_LABELS[value],
}));

export const SUPPLEMENT_MEAL_RELATIONS_WITH_LABELS = SUPPLEMENT_MEAL_RELATIONS.map((value) => ({
  value,
  label: SUPPLEMENT_MEAL_RELATION_LABELS[value],
}));

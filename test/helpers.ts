import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { FoodItem } from "../src/types.js";

export function makeFoodItem(
  overrides: Partial<Omit<FoodItem, "cached_at" | "updated_at">> = {}
): Omit<FoodItem, "cached_at" | "updated_at"> {
  const id = overrides.id ?? `test_${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    name: "Test Food",
    brand: null,
    type: "everyday",
    ean_13: null,
    source_tier: "local",
    source_id: id,
    source_query: null,
    calories: 100,
    protein: 10,
    fat: 5,
    carbs: 15,
    fiber: 2,
    sugar: 3,
    sodium: 200,
    serving_size: "100g",
    serving_weight_g: 100,
    alternate_names_text: null,
    labels: null,
    ingredients: null,
    data_source: null,
    ...overrides,
  };
}

export function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `nutrition-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

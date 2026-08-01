import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { FoodItem } from "../src/types.js";

// Default serving_weight_g is 170 (NOT 100) deliberately — a 100g default makes scaling a
// no-op (`* 100/100`), which is exactly why the original per-100g/per-serving bug shipped with
// 43 passing tests: every fixture scaled identically whether the scaling code existed or not.
// Tests that specifically want the per-100g/identity/NULL-weight cases override explicitly.
export const DEFAULT_TEST_SERVING_WEIGHT_G = 170;

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
    serving_size: "1 serving",
    serving_weight_g: DEFAULT_TEST_SERVING_WEIGHT_G,
    alternate_names_text: null,
    labels: null,
    ingredients: null,
    data_source: null,
    is_correction: 0,
    verified_fields: null,
    ...overrides,
  };
}

export function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `nutrition-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

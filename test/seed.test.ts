import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapTsvRow } from "../src/seed.js";

function tsvRow(nutrition: Record<string, unknown>, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: "test123",
    name: "Test Food",
    nutrition_100g: JSON.stringify(nutrition),
    ...overrides,
  };
}

describe("mapTsvRow — seed-time mass-conservation guard (#10)", () => {
  it("skips a row whose protein+carbs+fat exceed 100g per 100g (stops corrupt local rows at the source)", () => {
    // Real usda_1838212-shaped corruption, but as a local-tier row: sum = 950g.
    const row = tsvRow({ calories: 4380, protein: 250, total_fat: 138, carbohydrates: 562 });
    assert.equal(mapTsvRow(row), null);
  });

  it("keeps a normal row unaffected", () => {
    const row = tsvRow({ calories: 165, protein: 31, total_fat: 3.6, carbohydrates: 0 });
    const mapped = mapTsvRow(row);
    assert.ok(mapped);
    assert.equal(mapped!.calories, 165);
    assert.equal(mapped!.protein, 31);
  });

  it("keeps a row exactly at the 100g boundary (not corrupt)", () => {
    const row = tsvRow({ calories: 400, protein: 40, total_fat: 20, carbohydrates: 40 });
    assert.ok(mapTsvRow(row));
  });

  it("still returns null for missing name/id regardless of the mass check (existing behavior unchanged)", () => {
    assert.equal(mapTsvRow(tsvRow({ calories: 100 }, { name: "" })), null);
    assert.equal(mapTsvRow(tsvRow({ calories: 100 }, { id: "" })), null);
  });
});

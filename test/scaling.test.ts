import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toFoodResponse, toSearchResponse, resolveOverrideInput } from "../src/scaling.js";
import { MACRO_FIELDS } from "../src/types.js";
import type { RawFoodRow, SearchResult } from "../src/types.js";
import { makeFoodItem } from "./helpers.js";

function rawRow(overrides: Partial<RawFoodRow> = {}): RawFoodRow {
  return {
    ...makeFoodItem(),
    cached_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    superseded_by: null,
    ...overrides,
  };
}

describe("scaling — the bug this issue fixes", () => {
  describe("real regression fixtures (physical labels as ground truth)", () => {
    it("Chobani Vanilla Nonfat Greek Yogurt (170g): 76/8.24 per 100g -> 130/14 per serving", () => {
      const row = rawRow({
        id: "on_fd_nuJTMSjBaTjf",
        name: "Chobani Vanilla Nonfat Greek Yogurt",
        calories: 76,
        protein: 8.24,
        serving_weight_g: 170,
        serving_size: "1 cup",
      });
      const response = toFoodResponse(row);
      assert.equal(response.basis, "per_serving");
      assert.equal(response.basis_weight_g, 170);
      // 76 * 1.7 = 129.2 -> rounds to 129 (label prints 130 — the label's own printed value
      // undergoes independent packaging-rounding rules; the fix's job is the arithmetic, and
      // 129 vs. label 130 is within a gram of agreement, not the 41.5%-off unscaled bug this
      // fixes). What matters is it's no longer 76.
      assert.equal(response.calories, 129);
      assert.equal(response.protein, 14); // 8.24 * 1.7 = 14.008 -> rounds to 14.0 (label: 14)
      assert.equal(response.per_100g.calories, 76); // canonical value preserved
      assert.equal(response.per_100g.protein, 8.24);
      // The original serving_size string is never rewritten.
      assert.equal(response.serving_size, "1 cup");
    });

    it("G2G Almond Coconut Protein Bar (70g): 429/25.7 per 100g -> 300/18 per serving", () => {
      const row = rawRow({
        id: "on_fd_vUZSKMYWbRkt",
        name: "G2G Coconut Almond Protein Bar",
        calories: 429,
        protein: 25.7,
        serving_weight_g: 70,
        serving_size: "1 bar",
      });
      const response = toFoodResponse(row);
      assert.equal(response.basis, "per_serving");
      assert.equal(response.calories, 300); // 429 * 0.7 = 300.3 -> 300 (label: 300)
      assert.equal(response.protein, 18); // 25.7 * 0.7 = 17.99 -> 18.0 (label: 18)
      assert.equal(response.per_100g.calories, 429);
    });

    it("web_3b3e20c5808f-shaped duplicate: same bug, same fix, regardless of source_tier", () => {
      // The issue's Bug 2: a web-tier row byte-identical to the G2G local row. The scaling fix
      // corrects it identically because it operates on the stored per-100g values + weight, not
      // on source_tier — no special-casing needed, no "correction" of the row itself required.
      const row = rawRow({
        id: "web_3b3e20c5808f",
        source_tier: "web",
        calories: 429,
        protein: 25.7,
        serving_weight_g: 70,
      });
      const response = toFoodResponse(row);
      assert.equal(response.calories, 300);
      assert.equal(response.protein, 18);
    });
  });

  describe("property: scaled = stored * weight/100 on every field present", () => {
    it("holds for arbitrary non-100 weights, full FoodResponse shape", () => {
      for (const weight of [37, 55, 88, 125, 250, 340]) {
        const row = rawRow({
          calories: 200,
          protein: 12.3,
          fat: 8.1,
          carbs: 20.5,
          fiber: 3.2,
          sugar: 5.5,
          sodium: 410,
          serving_weight_g: weight,
        });
        const response = toFoodResponse(row);
        for (const field of MACRO_FIELDS) {
          const stored = row[field] as number;
          const expected = stored * (weight / 100);
          const rounded = field === "calories" || field === "sodium"
            ? Math.round(expected)
            : Math.round(expected * 10) / 10;
          assert.equal(response[field], rounded, `field ${field} at weight ${weight}`);
        }
      }
    });

    it("holds for the lean SearchResponse shape (calories/protein/fat/carbs only)", () => {
      const row: SearchResult = {
        id: "s1",
        name: "Test",
        brand: null,
        calories: 150,
        protein: 9,
        fat: 4,
        carbs: 18,
        serving_size: "1 bar",
        serving_weight_g: 55,
        source_tier: "local",
        is_correction: 0,
        verified_fields: null,
        superseded_by: null,
      };
      const response = toSearchResponse(row);
      assert.equal(response.calories, Math.round(150 * 0.55));
      assert.equal(response.protein, Math.round(9 * 0.55 * 10) / 10);
      // fiber/sugar/sodium were never selected by search() — must not appear at all.
      assert.equal("fiber" in response, false);
      assert.equal("sugar" in response, false);
      assert.equal("sodium" in response, false);
    });
  });

  describe("NULL-weight rows (13.5% of the corpus) — relabel, don't rewrite (R7)", () => {
    it("returns basis: per_100g, basis_weight_g: null, and never rewrites serving_size", () => {
      const row = rawRow({
        serving_weight_g: null,
        serving_size: "1 bar", // must NOT become "100 g"
        calories: 429,
        protein: 25.7,
      });
      const response = toFoodResponse(row);
      assert.equal(response.basis, "per_100g");
      assert.equal(response.basis_weight_g, null);
      assert.equal(response.serving_size, "1 bar");
      // Headline values equal the stored per-100g values verbatim (no scaling attempted).
      assert.equal(response.calories, 429);
      assert.equal(response.protein, 25.7);
    });

    it("never returns basis: per_serving with a null weight (also covers weight=0)", () => {
      for (const weight of [null, 0]) {
        const response = toFoodResponse(rawRow({ serving_weight_g: weight }));
        assert.notEqual(response.basis, "per_serving");
        assert.equal(response.basis_weight_g, null);
      }
    });
  });

  describe("rounding — per-field, not uniform (R9)", () => {
    it("rounds calories and sodium to integers, other macros to 1 decimal", () => {
      const row = rawRow({
        calories: 123.456,
        protein: 10.456,
        fat: 5.449,
        carbs: 15.05,
        fiber: 2.44,
        sugar: 3.06,
        sodium: 199.6,
        serving_weight_g: 100,
      });
      const response = toFoodResponse(row);
      assert.equal(response.calories, 123);
      assert.equal(response.sodium, 200);
      assert.equal(response.protein, 10.5);
      assert.equal(response.fat, 5.4);
      assert.equal(response.carbs, 15.1);
    });
  });

  describe("atwater_delta_pct — a signed number, never a binary flag (R4/R5)", () => {
    it("is ~0 when calories exactly matches 4P + 4C + 9F", () => {
      // 10*4 + 20*4 + 5*9 = 40 + 80 + 45 = 165
      const row = rawRow({ calories: 165, protein: 10, carbs: 20, fat: 5 });
      const response = toFoodResponse(row);
      assert.equal(response.atwater_delta_pct, 0);
    });

    it("is a nonzero signed percentage when stated calories diverge from the macros", () => {
      // Atwater implies 165; stated is 200 -> +21.2%
      const row = rawRow({ calories: 200, protein: 10, carbs: 20, fat: 5 });
      const response = toFoodResponse(row);
      assert.ok(response.atwater_delta_pct !== null);
      assert.ok((response.atwater_delta_pct as number) > 0);
    });

    it("is null when any of the four Atwater inputs is null", () => {
      const row = rawRow({ calories: 100, protein: null, carbs: 20, fat: 5 });
      const response = toFoodResponse(row);
      assert.equal(response.atwater_delta_pct, null);
    });

    it("is computed from canonical per-100g values, not the scaled/rounded headline ones", () => {
      // Same underlying per-100g macros at two different weights must produce the same delta.
      const a = toFoodResponse(rawRow({ calories: 200, protein: 10, carbs: 20, fat: 5, serving_weight_g: 37 }));
      const b = toFoodResponse(rawRow({ calories: 200, protein: 10, carbs: 20, fat: 5, serving_weight_g: 250 }));
      assert.equal(a.atwater_delta_pct, b.atwater_delta_pct);
    });
  });

  describe("is_correction / verified_fields / superseded_by pass through correctly", () => {
    it("exposes is_correction as a real boolean, never overloading source_tier", () => {
      const correction = toFoodResponse(rawRow({ is_correction: 1, source_tier: "web" }));
      const original = toFoodResponse(rawRow({ is_correction: 0, source_tier: "web" }));
      assert.equal(correction.is_correction, true);
      assert.equal(original.is_correction, false);
    });

    it("parses verified_fields JSON, defaults to null", () => {
      const verified = toFoodResponse(rawRow({ verified_fields: JSON.stringify(["calories", "protein"]) }));
      assert.deepEqual(verified.verified_fields, ["calories", "protein"]);
      const unverified = toFoodResponse(rawRow({ verified_fields: null }));
      assert.equal(unverified.verified_fields, null);
    });

    it("passes superseded_by through unchanged (null or an id)", () => {
      assert.equal(toFoodResponse(rawRow({ superseded_by: null })).superseded_by, null);
      assert.equal(
        toFoodResponse(rawRow({ superseded_by: "web_correction123" })).superseded_by,
        "web_correction123"
      );
    });
  });
});

describe("resolveOverrideInput — nutrition_override's basis validation/conversion", () => {
  it("R10: rejects basis per_serving with a macro field but no serving_weight_g", () => {
    const result = resolveOverrideInput("per_serving", undefined, { calories: 300 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /serving_weight_g/);
    }
  });

  it("does not reject when no macro fields are supplied, even without serving_weight_g", () => {
    const result = resolveOverrideInput("per_serving", undefined, {});
    assert.equal(result.ok, true);
  });

  it("converts per-serving label values to canonical per-100g", () => {
    // G2G-shaped correction: 300 cal / 18 g protein at a 70g serving -> 428.57 / 25.71 per 100g
    const result = resolveOverrideInput("per_serving", 70, { calories: 300, protein: 18 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(Math.abs((result.converted.calories as number) - 428.5714) < 0.001);
      assert.ok(Math.abs((result.converted.protein as number) - 25.7143) < 0.001);
      assert.deepEqual(result.suppliedMacros.sort(), ["calories", "protein"]);
    }
  });

  it("passes per_100g values through unconverted", () => {
    const result = resolveOverrideInput("per_100g", undefined, { calories: 429, protein: 25.7 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.converted.calories, 429);
      assert.equal(result.converted.protein, 25.7);
    }
  });

  it("per_100g basis never requires serving_weight_g", () => {
    const result = resolveOverrideInput("per_100g", undefined, { calories: 429 });
    assert.equal(result.ok, true);
  });
});

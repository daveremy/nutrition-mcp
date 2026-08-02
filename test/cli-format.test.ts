import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatSearchTable } from "../src/cli-format.js";
import type { SearchResponse } from "../src/types.js";

function searchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    id: "test_1",
    name: "Test Food",
    brand: null,
    source_tier: "local",
    serving_size: "1 serving",
    basis: "per_serving",
    basis_weight_g: 100,
    weight_source: "column",
    per_100g: {},
    atwater_delta_pct: null,
    is_correction: false,
    verified_fields: null,
    superseded_by: null,
    data_quality: null,
    macro_mass_g: null,
    calories: 200,
    protein: 10,
    fat: 5,
    carbs: 20,
    ...overrides,
  };
}

describe("formatSearchTable — CLI presentation layer (#9)", () => {
  it("returns 'No results found.' for an empty result set", () => {
    assert.equal(formatSearchTable([]), "No results found.");
  });

  it("prints a bare 'Cal' header when every result is per_serving (unchanged common case)", () => {
    const table = formatSearchTable([searchResponse()]);
    assert.match(table, /\bCal\b/);
    assert.doesNotMatch(table, /Cal\/100g/);
  });

  it("prints a 'Cal/100g' header when every result is per_100g — the issue's exact repro (Bertolli olive oil)", () => {
    const table = formatSearchTable([
      searchResponse({
        id: "on_bertolli",
        name: "Bertolli Cooking Olive Oil",
        basis: "per_100g",
        basis_weight_g: null,
        weight_source: null,
        calories: 800,
        protein: 0,
        fat: 93.3,
        carbs: 0,
      }),
    ]);
    assert.match(table, /Cal\/100g/);
    assert.match(table, /800\.0/);
  });

  it("labels two separate groups when the result set mixes both bases", () => {
    const table = formatSearchTable([
      searchResponse({ id: "s1", name: "Serving Food", basis: "per_serving" }),
      searchResponse({ id: "h1", name: "Hundred Gram Food", basis: "per_100g", basis_weight_g: null, weight_source: null }),
    ]);
    assert.match(table, /Per serving:/);
    assert.match(table, /Per 100g \(unscaled\):/);
    // Each group carries its own correctly-labeled header.
    assert.match(table, /Cal\/100g/);
    assert.match(table, /(?<!\/100g)\bCal\b/);
  });

  it("marks a corrupt (impossible_macros) row visibly in the name column", () => {
    const table = formatSearchTable([
      searchResponse({
        id: "usda_1838212",
        name: "Boost High Protein Nutritional Drink",
        basis: "per_100g",
        basis_weight_g: null,
        weight_source: null,
        data_quality: "impossible_macros",
        macro_mass_g: 950,
        calories: 4380,
        protein: 250,
        fat: 138,
        carbs: 562,
      }),
    ]);
    assert.match(table, /⚠.*Boost High Protein Nutritional Drink/);
    // And it must never show the pre-guard amplified value.
    assert.doesNotMatch(table, /10512/);
  });

  it("does not mark a non-corrupt row", () => {
    const table = formatSearchTable([searchResponse({ data_quality: null })]);
    assert.doesNotMatch(table, /⚠/);
  });
});

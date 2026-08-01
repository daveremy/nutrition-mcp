import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseServingWeight, isDensitySensitiveFood } from "../src/serving-parse.js";

describe("parseServingWeight — #5, tiered derivation from serving_size", () => {
  describe("Tier A — explicit grams (zero ambiguity)", () => {
    it("parses the DB's all-caps GRM abbreviation", () => {
      assert.deepEqual(parseServingWeight("42GRM"), { weight_g: 42, weight_source: "parsed_grams" });
      assert.deepEqual(parseServingWeight("235GRM"), { weight_g: 235, weight_source: "parsed_grams" });
    });

    it("parses spaced/lowercase/no-space gram forms", () => {
      assert.deepEqual(parseServingWeight("30 g"), { weight_g: 30, weight_source: "parsed_grams" });
      assert.deepEqual(parseServingWeight("100g"), { weight_g: 100, weight_source: "parsed_grams" });
      assert.deepEqual(parseServingWeight("42grm"), { weight_g: 42, weight_source: "parsed_grams" });
      assert.deepEqual(parseServingWeight("70 grams"), { weight_g: 70, weight_source: "parsed_grams" });
    });

    it("handles decimal gram values", () => {
      assert.deepEqual(parseServingWeight("12.5g"), { weight_g: 12.5, weight_source: "parsed_grams" });
    });
  });

  describe("Tier B — mass ounces (deterministic x28.3495)", () => {
    it("parses '8 oz' as mass, not volume", () => {
      const result = parseServingWeight("8 oz");
      assert.equal(result?.weight_source, "parsed_mass");
      assert.equal(result?.weight_g, Math.round(8 * 28.3495 * 100) / 100);
    });

    it("parses a no-space oz form", () => {
      const result = parseServingWeight("2oz");
      assert.equal(result?.weight_source, "parsed_mass");
    });
  });

  describe("Tier B/C boundary — fl oz is VOLUME, never mass (the issue's named danger)", () => {
    it("'8 fl oz' is parsed_volume, not parsed_mass", () => {
      const result = parseServingWeight("8 fl oz");
      assert.equal(result?.weight_source, "parsed_volume");
      assert.equal(result?.weight_g, 8 * 30); // FDA-label rounding: 1 fl oz = 30 mL
    });

    it("compact 'fl.oz' / no-space USDA-style forms also resolve to volume", () => {
      assert.equal(parseServingWeight("8fl oz")?.weight_source, "parsed_volume");
      assert.equal(parseServingWeight("8 fl.oz")?.weight_source, "parsed_volume");
    });
  });

  describe("Tier C — volumetric, density-assumed (weaker signal)", () => {
    it("parses 'ml' directly (density 1.0 g/mL)", () => {
      assert.deepEqual(parseServingWeight("240 ml"), { weight_g: 240, weight_source: "parsed_volume" });
      assert.deepEqual(parseServingWeight("355 ml"), { weight_g: 355, weight_source: "parsed_volume" });
      assert.deepEqual(parseServingWeight("15 ml"), { weight_g: 15, weight_source: "parsed_volume" });
    });

    it("parses cup/tbsp/tsp using FDA nutrition-label rounding conventions", () => {
      assert.deepEqual(parseServingWeight("1 cup"), { weight_g: 240, weight_source: "parsed_volume" });
      assert.deepEqual(parseServingWeight("1 tbsp"), { weight_g: 15, weight_source: "parsed_volume" });
      assert.deepEqual(parseServingWeight("2 tbsp"), { weight_g: 30, weight_source: "parsed_volume" });
      assert.deepEqual(parseServingWeight("1 tsp"), { weight_g: 5, weight_source: "parsed_volume" });
    });

    it("parses decimal cup servings", () => {
      assert.deepEqual(parseServingWeight("0.75 cup"), { weight_g: 180, weight_source: "parsed_volume" });
    });

    it("parses liters", () => {
      assert.deepEqual(parseServingWeight("1 l"), { weight_g: 1000, weight_source: "parsed_volume" });
      assert.deepEqual(parseServingWeight("0.5 liter"), { weight_g: 500, weight_source: "parsed_volume" });
    });

    it("does not confuse 'lb' or other l-prefixed units with liters", () => {
      assert.equal(parseServingWeight("1 lb"), null);
    });
  });

  describe("unparseable strings — never guess (the issue's explicit examples)", () => {
    it("'1 bottle' and '1 can' are not parseable", () => {
      assert.equal(parseServingWeight("1 bottle"), null);
      assert.equal(parseServingWeight("1 can"), null);
    });

    it("returns null for null/undefined/empty input", () => {
      assert.equal(parseServingWeight(null), null);
      assert.equal(parseServingWeight(undefined), null);
      assert.equal(parseServingWeight(""), null);
      assert.equal(parseServingWeight("   "), null);
    });

    it("returns null for zero or unparseable numbers", () => {
      assert.equal(parseServingWeight("0 g"), null);
      assert.equal(parseServingWeight("some words"), null);
    });
  });

  describe("isDensitySensitiveFood — gates Tier C for known-wrong-at-1.0-g/mL categories", () => {
    it("flags the issue's named categories: oil, honey, and near-synonyms", () => {
      assert.equal(isDensitySensitiveFood("Extra Virgin Olive Oil"), true);
      assert.equal(isDensitySensitiveFood("Wildflower Honey"), true);
      assert.equal(isDensitySensitiveFood("Maple Syrup"), true);
      assert.equal(isDensitySensitiveFood("Blackstrap Molasses"), true);
      assert.equal(isDensitySensitiveFood("Salted Butter"), true);
      assert.equal(isDensitySensitiveFood("Vegetable Shortening"), true);
    });

    it("is case-insensitive and matches whole words only", () => {
      assert.equal(isDensitySensitiveFood("olive oil"), true);
      assert.equal(isDensitySensitiveFood("OLIVE OIL"), true);
      // "boiled" contains "oil" as a substring but not as a whole word.
      assert.equal(isDensitySensitiveFood("Boiled Eggs"), false);
    });

    it("does not flag water-like liquids or unrelated foods", () => {
      assert.equal(isDensitySensitiveFood("Whole Milk"), false);
      assert.equal(isDensitySensitiveFood("Orange Juice"), false);
      assert.equal(isDensitySensitiveFood("Chicken Broth"), false);
      assert.equal(isDensitySensitiveFood("Greek Yogurt"), false);
    });

    it("returns false for null/undefined names", () => {
      assert.equal(isDensitySensitiveFood(null), false);
      assert.equal(isDensitySensitiveFood(undefined), false);
    });
  });

  describe("case insensitivity", () => {
    it("matches regardless of case for every tier", () => {
      assert.equal(parseServingWeight("100G")?.weight_source, "parsed_grams");
      assert.equal(parseServingWeight("8 OZ")?.weight_source, "parsed_mass");
      assert.equal(parseServingWeight("8 FL OZ")?.weight_source, "parsed_volume");
      assert.equal(parseServingWeight("1 CUP")?.weight_source, "parsed_volume");
    });
  });
});

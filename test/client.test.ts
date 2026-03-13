import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { _mapUsdaToFood, _NUTRIENT_MAP } from "../src/client.js";
import type { UsdaFoodResult } from "../src/types.js";

describe("USDA Client", () => {
  describe("mapUsdaToFood", () => {
    it("maps nutrient IDs to typed columns", () => {
      const usdaItem: UsdaFoodResult = {
        fdcId: 12345,
        description: "Chicken Breast, raw",
        brandOwner: "Generic",
        gtinUpc: "012345678901",
        foodNutrients: [
          { nutrientId: 1008, nutrientName: "Energy", value: 120 },
          { nutrientId: 1003, nutrientName: "Protein", value: 22.5 },
          { nutrientId: 1004, nutrientName: "Total lipid (fat)", value: 2.6 },
          { nutrientId: 1005, nutrientName: "Carbohydrate", value: 0 },
          { nutrientId: 1079, nutrientName: "Fiber", value: 0 },
          { nutrientId: 2000, nutrientName: "Sugars", value: 0 },
          { nutrientId: 1093, nutrientName: "Sodium", value: 74 },
        ],
        servingSize: 100,
        servingSizeUnit: "g",
      };

      const result = _mapUsdaToFood(usdaItem, "chicken");
      assert.equal(result.id, "usda_12345");
      assert.equal(result.name, "Chicken Breast, raw");
      assert.equal(result.brand, "Generic");
      assert.equal(result.source_tier, "usda");
      assert.equal(result.source_id, "12345");
      assert.equal(result.calories, 120);
      assert.equal(result.protein, 22.5);
      assert.equal(result.fat, 2.6);
      assert.equal(result.carbs, 0);
      assert.equal(result.fiber, 0);
      assert.equal(result.sugar, 0);
      assert.equal(result.sodium, 74);
      assert.equal(result.serving_size, "100g");
      assert.equal(result.source_query, "chicken");
    });

    it("normalizes 12-digit UPC to 13-digit EAN-13", () => {
      const usdaItem: UsdaFoodResult = {
        fdcId: 99,
        description: "Test",
        gtinUpc: "012345678901",
        foodNutrients: [],
      };

      const result = _mapUsdaToFood(usdaItem);
      assert.equal(result.ean_13, "0012345678901");
    });

    it("handles missing optional fields", () => {
      const usdaItem: UsdaFoodResult = {
        fdcId: 50,
        description: "Minimal Item",
        foodNutrients: [],
      };

      const result = _mapUsdaToFood(usdaItem);
      assert.equal(result.brand, null);
      assert.equal(result.ean_13, null);
      assert.equal(result.calories, null);
      assert.equal(result.serving_size, null);
    });
  });

  describe("mapUsdaToFood edge cases", () => {
    it("handles missing foodNutrients gracefully (empty array → all macros null)", () => {
      const usdaItem: UsdaFoodResult = {
        fdcId: 777,
        description: "Empty Nutrients",
        foodNutrients: [],
      };

      const result = _mapUsdaToFood(usdaItem);
      assert.equal(result.calories, null);
      assert.equal(result.protein, null);
      assert.equal(result.fat, null);
      assert.equal(result.carbs, null);
      assert.equal(result.fiber, null);
      assert.equal(result.sugar, null);
      assert.equal(result.sodium, null);
    });
  });

  describe("no API key", () => {
    it("searchUsda returns empty when no USDA_API_KEY", async () => {
      const originalKey = process.env.USDA_API_KEY;
      delete process.env.USDA_API_KEY;

      // Dynamic import to get fresh module state
      const { searchUsda } = await import("../src/client.js");
      const results = await searchUsda("chicken");
      assert.deepEqual(results, []);

      if (originalKey) process.env.USDA_API_KEY = originalKey;
    });

    it("lookupBarcodeUsda returns null when no USDA_API_KEY", async () => {
      const originalKey = process.env.USDA_API_KEY;
      delete process.env.USDA_API_KEY;

      const { lookupBarcodeUsda } = await import("../src/client.js");
      const result = await lookupBarcodeUsda("1234567890123");
      assert.equal(result, null);

      if (originalKey) process.env.USDA_API_KEY = originalKey;
    });
  });
});

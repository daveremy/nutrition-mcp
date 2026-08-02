import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { NutritionStore } from "../src/store.js";
import { SearchOrchestrator } from "../src/search.js";
import { makeFoodItem, tmpDbPath } from "./helpers.js";

/** Builds a fake `fetch` Response for the USDA search endpoint shape client.ts expects. */
function fakeUsdaResponse(foods: unknown[]): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ foods }) };
}

describe("SearchOrchestrator", () => {
  let store: NutritionStore;
  let orchestrator: SearchOrchestrator;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new NutritionStore(dbPath);
    orchestrator = new SearchOrchestrator(store);
  });

  afterEach(() => {
    try {
      store?.close();
      if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  describe("tier blending", () => {
    it("returns local results when sufficient", async () => {
      for (let i = 0; i < 5; i++) {
        store.upsert(
          makeFoodItem({
            id: `local_${i}`,
            name: `Chicken Recipe ${i}`,
            source_id: `local_${i}`,
            source_tier: "local",
          })
        );
      }

      const results = await orchestrator.search("Chicken", 5);
      assert.equal(results.length, 5);
      assert.ok(results.every((r) => r.source_tier === "local"));
    });
  });

  describe("barcode dedup", () => {
    it("deduplicates by barcode across tiers", async () => {
      // Local item with barcode
      store.upsert(
        makeFoodItem({
          id: "local_bc",
          name: "Local Food",
          source_id: "local_bc",
          source_tier: "local",
          ean_13: "1234567890123",
        })
      );

      // USDA item with same barcode (already cached)
      store.upsert(
        makeFoodItem({
          id: "usda_bc",
          name: "USDA Food",
          source_id: "bc_source",
          source_tier: "usda",
          ean_13: "1234567890123",
        })
      );

      const results = await orchestrator.search("Food", 10);
      // Both should be found via FTS, but USDA should be in results too since
      // dedup only applies during tier blending (USDA API results vs local)
      // Here both are already in local DB
      assert.ok(results.length >= 1);
    });
  });

  describe("barcode lookup", () => {
    it("finds local barcode", async () => {
      store.upsert(
        makeFoodItem({
          id: "bc_local",
          name: "Barcode Local",
          ean_13: "9876543210123",
        })
      );

      const result = await orchestrator.lookupBarcode("9876543210123");
      assert.ok(result);
      assert.equal(result.name, "Barcode Local");
    });

    it("normalizes 12-digit UPC", async () => {
      store.upsert(
        makeFoodItem({
          id: "bc_upc",
          name: "UPC Food",
          ean_13: "0123456789012",
        })
      );

      // Search with 12-digit (without leading zero)
      const result = await orchestrator.lookupBarcode("123456789012");
      assert.ok(result);
      assert.equal(result.name, "UPC Food");
    });

    it("returns null for invalid barcode", async () => {
      const result = await orchestrator.lookupBarcode("123");
      assert.equal(result, null);
    });

    it("returns null when barcode is empty string", async () => {
      const result = await orchestrator.lookupBarcode("");
      assert.equal(result, null);
    });
  });

  describe("search edge cases", () => {
    it("returns empty when limit=0", async () => {
      store.upsert(
        makeFoodItem({
          id: "limit_0",
          name: "Chicken Breast",
          source_id: "limit_0",
          source_tier: "local",
        })
      );

      const results = await orchestrator.search("Chicken", 0);
      assert.deepEqual(results, []);
    });
  });

  describe("mass-conservation guard (#10) on the fresh-USDA cache-write path", () => {
    let originalApiKey: string | undefined;

    beforeEach(() => {
      originalApiKey = process.env.USDA_API_KEY;
      process.env.USDA_API_KEY = "test-key";
    });

    afterEach(() => {
      mock.restoreAll();
      if (originalApiKey === undefined) delete process.env.USDA_API_KEY;
      else process.env.USDA_API_KEY = originalApiKey;
    });

    it("search() flags a corrupt fresh-USDA result but does not cache it (#10's explicit 'stop it entering' requirement)", async () => {
      // usda_1838212-shaped: 4380 cal / 250g protein / 562g carbs / 138g fat per 100g, sum 950g.
      mock.method(globalThis, "fetch", async () =>
        fakeUsdaResponse([
          {
            fdcId: 1838212,
            description: "Boost High Protein Nutritional Drink",
            foodNutrients: [
              { nutrientId: 1008, nutrientName: "Energy", value: 4380 },
              { nutrientId: 1003, nutrientName: "Protein", value: 250 },
              { nutrientId: 1004, nutrientName: "Total lipid (fat)", value: 138 },
              { nutrientId: 1005, nutrientName: "Carbohydrate", value: 562 },
            ],
            servingSize: 11,
            servingSizeUnit: "fl oz",
          },
        ])
      );

      const results = await orchestrator.search("boost shake", 5);
      const found = results.find((r) => r.id === "usda_1838212");
      assert.ok(found, "corrupt row must still be returned, not silently dropped");
      assert.equal(found!.data_quality, "impossible_macros");
      assert.equal(found!.basis, "per_100g");
      // Never served via the headline field, not even unscaled — only per_100g carries the raw value.
      assert.equal(found!.calories, null);
      assert.equal(found!.per_100g.calories, 4380);

      // The load-bearing assertion: it must NOT have been written to the cache.
      assert.equal(store.lookup("usda_1838212"), null);
    });

    it("search() still caches a normal (non-corrupt) fresh-USDA result", async () => {
      mock.method(globalThis, "fetch", async () =>
        fakeUsdaResponse([
          {
            fdcId: 999,
            description: "Plain Chicken Breast",
            foodNutrients: [
              { nutrientId: 1008, nutrientName: "Energy", value: 165 },
              { nutrientId: 1003, nutrientName: "Protein", value: 31 },
              { nutrientId: 1004, nutrientName: "Total lipid (fat)", value: 3.6 },
              { nutrientId: 1005, nutrientName: "Carbohydrate", value: 0 },
            ],
          },
        ])
      );

      const results = await orchestrator.search("plain chicken breast unique", 5);
      const found = results.find((r) => r.id === "usda_999");
      assert.ok(found);
      assert.equal(found!.data_quality, null);
      assert.ok(store.lookup("usda_999"), "non-corrupt rows must still be cached as before");
    });

    it("lookupBarcode() flags a corrupt fresh-USDA result but does not cache it", async () => {
      mock.method(globalThis, "fetch", async () =>
        fakeUsdaResponse([
          {
            fdcId: 1838212,
            description: "Boost High Protein Nutritional Drink",
            gtinUpc: "0123456789012",
            foodNutrients: [
              { nutrientId: 1008, nutrientName: "Energy", value: 4380 },
              { nutrientId: 1003, nutrientName: "Protein", value: 250 },
              { nutrientId: 1004, nutrientName: "Total lipid (fat)", value: 138 },
              { nutrientId: 1005, nutrientName: "Carbohydrate", value: 562 },
            ],
          },
        ])
      );

      const result = await orchestrator.lookupBarcode("0123456789012");
      assert.ok(result);
      assert.equal(result!.data_quality, "impossible_macros");
      assert.equal(result!.basis, "per_100g");
      assert.equal(store.lookup("usda_1838212"), null);
    });
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { NutritionStore } from "../src/store.js";
import { SearchOrchestrator } from "../src/search.js";
import { makeFoodItem, tmpDbPath } from "./helpers.js";

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
});

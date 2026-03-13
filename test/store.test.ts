import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { NutritionStore } from "../src/store.js";
import { makeFoodItem, tmpDbPath } from "./helpers.js";

describe("NutritionStore", () => {
  let store: NutritionStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new NutritionStore(dbPath);
  });

  afterEach(() => {
    try {
      store?.close();
      if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  describe("CRUD", () => {
    it("inserts and looks up a food item", () => {
      const food = makeFoodItem({ id: "test_1", name: "Chicken Breast" });
      store.upsert(food);
      const result = store.lookup("test_1");
      assert.ok(result);
      assert.equal(result.name, "Chicken Breast");
      assert.equal(result.calories, 100);
    });

    it("returns null for non-existent ID", () => {
      const result = store.lookup("does_not_exist");
      assert.equal(result, null);
    });

    it("looks up by barcode", () => {
      const food = makeFoodItem({
        id: "test_bc",
        name: "Barcode Food",
        ean_13: "1234567890123",
      });
      store.upsert(food);
      const result = store.lookupByBarcode("1234567890123");
      assert.ok(result);
      assert.equal(result.name, "Barcode Food");
    });
  });

  describe("FTS sync", () => {
    it("finds inserted items via FTS", () => {
      store.upsert(makeFoodItem({ id: "fts_1", name: "Grilled Salmon Fillet" }));
      const results = store.search("salmon");
      assert.equal(results.length, 1);
      assert.equal(results[0].name, "Grilled Salmon Fillet");
    });

    it("updates FTS on update", () => {
      store.upsert(makeFoodItem({ id: "fts_2", source_id: "fts_2", source_tier: "local", name: "Old Name" }));
      assert.equal(store.search("Old").length, 1);

      store.upsert(makeFoodItem({ id: "fts_2", source_id: "fts_2", source_tier: "local", name: "New Name" }));
      assert.equal(store.search("Old").length, 0);
      assert.equal(store.search("New").length, 1);
    });

    it("removes FTS entry on delete", () => {
      store.upsert(makeFoodItem({ id: "fts_3", name: "Deletable Item" }));
      assert.equal(store.search("Deletable").length, 1);

      store.db.prepare("DELETE FROM foods WHERE id = ?").run("fts_3");
      assert.equal(store.search("Deletable").length, 0);
    });

    it("searches by brand", () => {
      store.upsert(
        makeFoodItem({ id: "fts_4", name: "Protein Bar", brand: "Clif" })
      );
      const results = store.search("Clif");
      assert.equal(results.length, 1);
      assert.equal(results[0].brand, "Clif");
    });
  });

  describe("upsert ON CONFLICT", () => {
    it("preserves original id on conflict", () => {
      store.upsert(
        makeFoodItem({
          id: "usda_100",
          name: "First",
          source_tier: "usda",
          source_id: "100",
          calories: 50,
        })
      );

      // Upsert with same source_tier/source_id but different id
      store.upsert(
        makeFoodItem({
          id: "usda_100_new",
          name: "Updated",
          source_tier: "usda",
          source_id: "100",
          calories: 75,
        })
      );

      // Original id should be preserved
      const result = store.lookup("usda_100");
      assert.ok(result);
      assert.equal(result.name, "Updated");
      assert.equal(result.calories, 75);
    });

    it("merges non-null fields on conflict", () => {
      store.upsert(
        makeFoodItem({
          id: "usda_200",
          name: "Food",
          source_tier: "usda",
          source_id: "200",
          brand: "BrandA",
          fiber: 5,
        })
      );

      // Upsert with null brand but new fiber
      store.upsert(
        makeFoodItem({
          id: "usda_200_x",
          name: "Food",
          source_tier: "usda",
          source_id: "200",
          brand: null,
          fiber: 8,
        })
      );

      const result = store.lookup("usda_200");
      assert.ok(result);
      assert.equal(result.brand, "BrandA"); // preserved
      assert.equal(result.fiber, 8); // updated
    });
  });

  describe("bulk insert", () => {
    it("inserts many items in a transaction", () => {
      const items = Array.from({ length: 100 }, (_, i) =>
        makeFoodItem({ id: `bulk_${i}`, name: `Food ${i}`, source_id: `bulk_${i}` })
      );
      store.insertBulk(items);

      const stats = store.getStats();
      assert.equal(stats.total, 100);
    });
  });

  describe("barcode lookup tier preference", () => {
    it("prefers local tier over usda tier when both exist with same ean_13", () => {
      store.upsert(
        makeFoodItem({
          id: "local_dup",
          name: "Local Version",
          source_id: "local_dup",
          source_tier: "local",
          ean_13: "9999999999999",
        })
      );
      store.upsert(
        makeFoodItem({
          id: "usda_dup",
          name: "USDA Version",
          source_id: "usda_dup",
          source_tier: "usda",
          ean_13: "9999999999999",
        })
      );

      const result = store.lookupByBarcode("9999999999999");
      assert.ok(result);
      assert.equal(result.source_tier, "local");
      assert.equal(result.name, "Local Version");
    });
  });

  describe("FTS edge cases", () => {
    it("returns empty array for empty query", () => {
      store.upsert(makeFoodItem({ id: "fts_edge_1", name: "Some Food" }));
      const results = store.search("");
      assert.deepEqual(results, []);
    });

    it("returns empty array for whitespace-only query", () => {
      store.upsert(makeFoodItem({ id: "fts_edge_2", name: "Some Food" }));
      const results = store.search("   ");
      assert.deepEqual(results, []);
    });

    it("does not crash on special characters (asterisks, quotes)", () => {
      store.upsert(makeFoodItem({ id: "fts_edge_3", name: "Some Food" }));
      assert.doesNotThrow(() => store.search('***"hello"***'));
      assert.doesNotThrow(() => store.search("()[]{}^~|<>:@!&"));
    });
  });

  describe("delete", () => {
    it("deletes a usda entry", () => {
      store.upsert(makeFoodItem({ id: "usda_del", source_tier: "usda", source_id: "del1" }));
      assert.ok(store.lookup("usda_del"));

      const result = store.delete("usda_del");
      assert.equal(result.deleted, true);
      assert.equal(store.lookup("usda_del"), null);
    });

    it("deletes a web entry", () => {
      store.upsert(makeFoodItem({ id: "web_del", source_tier: "web", source_id: "del2" }));
      const result = store.delete("web_del");
      assert.equal(result.deleted, true);
    });

    it("refuses to delete local (on_) entries", () => {
      store.upsert(makeFoodItem({ id: "on_nodelete", source_tier: "local", source_id: "nd1" }));
      const result = store.delete("on_nodelete");
      assert.equal(result.deleted, false);
      assert.ok(result.reason?.includes("Cannot delete"));
      assert.ok(store.lookup("on_nodelete")); // still exists
    });

    it("returns deleted=false for non-existent ID", () => {
      const result = store.delete("does_not_exist");
      assert.equal(result.deleted, false);
    });

    it("removes FTS entry on delete", () => {
      store.upsert(makeFoodItem({ id: "usda_fts_del", name: "Unique Deletable", source_tier: "usda", source_id: "fd1" }));
      assert.equal(store.search("Unique Deletable").length, 1);

      store.delete("usda_fts_del");
      assert.equal(store.search("Unique Deletable").length, 0);
    });
  });

  describe("override", () => {
    it("creates an override for an existing food", () => {
      store.upsert(makeFoodItem({
        id: "usda_orig",
        name: "Wrong Calories Food",
        source_tier: "usda",
        source_id: "orig1",
        calories: 999,
        protein: 20,
      }));

      const result = store.override("usda_orig", { calories: 150 });
      assert.equal(result.overridden, true);
      assert.ok(result.override_id?.startsWith("web_"));

      // Override should exist with corrected calories and inherited protein
      const override = store.lookup(result.override_id!);
      assert.ok(override);
      assert.equal(override.calories, 150);
      assert.equal(override.protein, 20); // inherited
      assert.equal(override.name, "Wrong Calories Food"); // inherited
      assert.equal(override.source_tier, "web");
    });

    it("returns overridden=false for non-existent food", () => {
      const result = store.override("nonexistent", { calories: 100 });
      assert.equal(result.overridden, false);
      assert.ok(result.reason?.includes("not found"));
    });

    it("reuses same override on repeated calls (dedup by source_id)", () => {
      store.upsert(makeFoodItem({
        id: "usda_reoverride",
        name: "Food",
        source_tier: "usda",
        source_id: "ro1",
        calories: 100,
      }));

      const r1 = store.override("usda_reoverride", { calories: 200 });
      const r2 = store.override("usda_reoverride", { calories: 300 });
      assert.equal(r1.overridden, true);
      assert.equal(r2.overridden, true);

      // Both should target the same override entry (ON CONFLICT by source_tier+source_id)
      // The second override should update the first
      const override = store.lookup(r1.override_id!);
      assert.ok(override);
      assert.equal(override.calories, 300); // latest value
    });

    it("override inherits barcode from original", () => {
      store.upsert(makeFoodItem({
        id: "usda_bc_override",
        name: "Barcode Food",
        source_tier: "usda",
        source_id: "bco1",
        ean_13: "1111111111111",
      }));

      const result = store.override("usda_bc_override", { calories: 50 });
      const override = store.lookup(result.override_id!);
      assert.ok(override);
      assert.equal(override.ean_13, "1111111111111");
    });
  });

  describe("getStats", () => {
    it("returns correct breakdown", () => {
      store.upsert(makeFoodItem({ id: "s1", source_tier: "local", source_id: "s1" }));
      store.upsert(makeFoodItem({ id: "s2", source_tier: "usda", source_id: "s2" }));
      store.upsert(makeFoodItem({ id: "s3", source_tier: "usda", source_id: "s3" }));

      const stats = store.getStats();
      assert.equal(stats.total, 3);
      assert.equal(stats.by_tier.local, 1);
      assert.equal(stats.by_tier.usda, 2);
    });
  });
});

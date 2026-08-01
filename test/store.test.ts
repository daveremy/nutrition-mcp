import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { NutritionStore } from "../src/store.js";
import { resolveOverrideInput } from "../src/scaling.js";
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
      // Default fixture weight is 170g (see helpers.ts) — the CRUD assertion checks the
      // canonical per_100g value here, not the scaled headline value, since that's what this
      // test is actually about; scaling itself is covered under "serving-basis scaling" below.
      const food = makeFoodItem({ id: "test_1", name: "Chicken Breast" });
      store.upsert(food);
      const result = store.lookup("test_1");
      assert.ok(result);
      assert.equal(result.name, "Chicken Breast");
      assert.equal(result.per_100g.calories, 100);
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
      // serving_weight_g: 100 here — this test is about ON CONFLICT id/field merge behavior,
      // not scaling, so it pins an identity scale to keep the calorie assertion simple.
      store.upsert(
        makeFoodItem({
          id: "usda_100",
          name: "First",
          source_tier: "usda",
          source_id: "100",
          calories: 50,
          serving_weight_g: 100,
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
          serving_weight_g: 100,
        })
      );

      // Original id should be preserved
      const result = store.lookup("usda_100");
      assert.ok(result);
      assert.equal(result.name, "Updated");
      assert.equal(result.calories, 75);
    });

    it("merges non-null fields on conflict", () => {
      // serving_weight_g: 100 — identity scale, this test is about field-merge semantics.
      store.upsert(
        makeFoodItem({
          id: "usda_200",
          name: "Food",
          source_tier: "usda",
          source_id: "200",
          brand: "BrandA",
          fiber: 5,
          serving_weight_g: 100,
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
          serving_weight_g: 100,
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
      // serving_weight_g: 100 — identity scale; this test is about override field semantics,
      // not scaling (that's covered separately under "correction precedence" below).
      store.upsert(makeFoodItem({
        id: "usda_orig",
        name: "Wrong Calories Food",
        source_tier: "usda",
        source_id: "orig1",
        calories: 999,
        protein: 20,
        serving_weight_g: 100,
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
      assert.equal(override.is_correction, true);
      assert.deepEqual(override.verified_fields, ["calories"]);
    });

    it("inherits canonical per-100g values, not scaled ones, for un-corrected fields", () => {
      // Regression guard for plan review round 5's P1: override() must read raw canonical rows
      // internally, never the public (serving-scaled) lookup(). A 170g serving with 100g-basis
      // protein=20 must inherit protein=20 into the override — not 20 scaled to the serving.
      store.upsert(makeFoodItem({
        id: "usda_scaled_orig",
        name: "Scaled Serving Food",
        source_tier: "usda",
        source_id: "scaled1",
        calories: 100,
        protein: 20,
        serving_weight_g: 170,
      }));

      const result = store.override("usda_scaled_orig", { calories: 150 });
      const override = store.lookup(result.override_id!);
      assert.ok(override);
      // protein wasn't corrected, so it must inherit the canonical (unscaled) 20 — not
      // lookup()'s public per-serving-scaled 34 (20 * 1.7).
      assert.equal(override.per_100g.protein, 20);
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
        serving_weight_g: 100,
      }));

      const r1 = store.override("usda_reoverride", { calories: 200 });
      const r2 = store.override("usda_reoverride", { calories: 300 });
      assert.equal(r1.overridden, true);
      assert.equal(r2.overridden, true);
      // Round-5 fix: repeat corrections must return the SAME override_id — a fresh id would
      // never actually be stored once ON CONFLICT fires (id is never in DO UPDATE SET).
      assert.equal(r2.override_id, r1.override_id);

      // Both should target the same override entry (ON CONFLICT by source_tier+source_id)
      // The second override should update the first
      const override = store.lookup(r1.override_id!);
      assert.ok(override);
      assert.equal(override.calories, 300); // latest value
    });

    it("merges verified_fields across repeat override calls instead of replacing them", () => {
      store.upsert(makeFoodItem({
        id: "usda_multi_verify",
        name: "Food",
        source_tier: "usda",
        source_id: "mv1",
        calories: 100,
        protein: 10,
        serving_weight_g: 100,
      }));

      const r1 = store.override("usda_multi_verify", { calories: 150 });
      const r2 = store.override("usda_multi_verify", { protein: 15 });
      assert.equal(r2.override_id, r1.override_id);

      const override = store.lookup(r1.override_id!);
      assert.ok(override);
      // Round 1 verified "calories" must not be dropped just because round 2 verified "protein".
      assert.deepEqual(new Set(override.verified_fields ?? []), new Set(["calories", "protein"]));
      // Code review round 2, P1: round 1's corrected calories=150 must survive round 2 (which
      // only supplied protein) — round 2 must inherit from the PRIOR override, not revert
      // unspecified fields back to the pristine original's calories=100.
      assert.equal(override.per_100g.calories, 150);
      assert.equal(override.per_100g.protein, 15);
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

    it("round-trips a per-serving physical-label correction back out through nutrition_lookup", () => {
      // Simulates exactly what the nutrition_override MCP tool handler does: resolveOverrideInput
      // validates/converts, then store.override() stores the canonical result. The G2G label
      // case — 300 cal / 18g protein at a 70g serving — must come back out as those same
      // per-serving numbers on the next lookup.
      store.upsert(makeFoodItem({
        id: "usda_roundtrip",
        name: "G2G-shaped Bar",
        source_tier: "usda",
        source_id: "rt1",
        calories: 429,
        protein: 25.7,
        serving_weight_g: 70,
      }));

      const resolved = resolveOverrideInput("per_serving", 70, { calories: 300, protein: 18 });
      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;

      const result = store.override("usda_roundtrip", {
        ...resolved.converted,
        serving_weight_g: 70,
      });
      assert.equal(result.overridden, true);

      const looked_up = store.lookup(result.override_id!);
      assert.ok(looked_up);
      assert.equal(looked_up.basis, "per_serving");
      assert.equal(looked_up.calories, 300);
      assert.equal(looked_up.protein, 18);
      assert.deepEqual(new Set(looked_up.verified_fields ?? []), new Set(["calories", "protein"]));
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

  describe("writes are never scaled (R14)", () => {
    it("upsert stores the canonical per-100g values verbatim, not scaled", () => {
      store.upsert(makeFoodItem({ id: "write_1", calories: 200, serving_weight_g: 170 }));
      // Raw column read (bypassing the public response shaping) must equal exactly what was
      // written — 200, never 200*1.7 — proving scaling only ever happens on the read side.
      const raw = store.db.prepare("SELECT calories FROM foods WHERE id = ?").get("write_1") as {
        calories: number;
      };
      assert.equal(raw.calories, 200);
    });

    it("insertBulk stores canonical values verbatim", () => {
      store.insertBulk([makeFoodItem({ id: "bulk_write_1", calories: 300, serving_weight_g: 70 })]);
      const raw = store.db.prepare("SELECT calories FROM foods WHERE id = ?").get("bulk_write_1") as {
        calories: number;
      };
      assert.equal(raw.calories, 300);
    });
  });

  describe("correction precedence across all four read paths (R2, R12, and the coordinator's superseded_by follow-up)", () => {
    function seedOriginalAndCorrection(): { originalId: string; overrideId: string } {
      const originalId = "usda_precedence_orig";
      store.upsert(
        makeFoodItem({
          id: originalId,
          name: "Precedence Test Food",
          source_tier: "usda",
          source_id: "prec1",
          calories: 999,
          ean_13: "5555555555555",
          serving_weight_g: 100,
        })
      );
      const result = store.override(originalId, { calories: 100 });
      assert.ok(result.override_id);
      return { originalId, overrideId: result.override_id! };
    }

    it("lookupByBarcode returns the correction, not the original (R2 — the severest finding)", () => {
      const { overrideId } = seedOriginalAndCorrection();
      const result = store.lookupByBarcode("5555555555555");
      assert.ok(result);
      assert.equal(result.id, overrideId);
      assert.equal(result.is_correction, true);
      assert.equal(result.calories, 100);
    });

    it("search surfaces trust via is_correction/superseded_by rather than reordering by trust (R12)", () => {
      // Deliberately NOT reordering search by is_correction (plan review round 1/2): a global
      // trust-tier boost would degrade FTS relevance for unrelated queries. Instead both rows
      // appear at their normal relevance rank, each carrying the signal an intelligent caller
      // needs to prefer the correction.
      const { originalId, overrideId } = seedOriginalAndCorrection();
      const results = store.search("Precedence Test Food");
      const original = results.find((r) => r.id === originalId);
      const correction = results.find((r) => r.id === overrideId);
      assert.ok(original);
      assert.ok(correction);
      assert.equal(original.is_correction, false);
      assert.equal(original.superseded_by, overrideId);
      assert.equal(correction.is_correction, true);
      assert.equal(correction.superseded_by, null);
    });

    it("listCached ranks the correction above the original", () => {
      const { originalId, overrideId } = seedOriginalAndCorrection();
      const results = store.listCached("all", 50, 0);
      const ids = results.map((r) => r.id);
      assert.ok(ids.indexOf(overrideId) < ids.indexOf(originalId));
    });

    it("lookup(original_id) has no winner to pick, but surfaces superseded_by (coordinator follow-up)", () => {
      const { originalId, overrideId } = seedOriginalAndCorrection();

      // Looking up the ORIGINAL id directly still returns the original's own values — id
      // immutability is preserved, no silent redirection...
      const originalLookup = store.lookup(originalId);
      assert.ok(originalLookup);
      assert.equal(originalLookup.calories, 999);
      assert.equal(originalLookup.is_correction, false);
      // ...but it is NOT silent about a correction existing: a caller that arrives at a stale/
      // persisted original id (a health-log entry, a "usual breakfast" shortcut) can see and
      // follow the correction rather than being told an uncorrected value with no signal.
      assert.equal(originalLookup.superseded_by, overrideId);

      // And looking up the correction's own id confirms it correctly.
      const correctionLookup = store.lookup(overrideId);
      assert.ok(correctionLookup);
      assert.equal(correctionLookup.calories, 100);
      assert.equal(correctionLookup.is_correction, true);
      assert.equal(correctionLookup.superseded_by, null);
    });
  });

  describe("schema migration is idempotent and safe on a pre-existing DB", () => {
    it("running migrateSchema twice does not error or lose data", () => {
      store.upsert(makeFoodItem({ id: "migrate_1", name: "Migration Food" }));
      // Re-opening runs migrateSchema again against the same (already-migrated) file.
      store.reopen();
      store.reopen();
      const result = store.lookup("migrate_1");
      assert.ok(result);
      assert.equal(result.name, "Migration Food");
    });

    it("simulates an existing pre-migration DB: dropping the new columns and reopening backfills them safely", () => {
      // Recreate the "before" state (a DB predating is_correction/verified_fields) by dropping
      // the columns, inserting an override-shaped row the old way, then reopening — the
      // migration must add the columns back AND backfill is_correction from the source_id
      // convention without erroring or losing the row.
      store.db.exec("ALTER TABLE foods DROP COLUMN is_correction");
      store.db.exec("ALTER TABLE foods DROP COLUMN verified_fields");
      store.db.prepare(
        `INSERT INTO foods (id, name, source_tier, source_id, calories)
         VALUES ('web_premigration', 'Pre-migration Override', 'web', 'override:usda_something', 100)`
      ).run();

      store.reopen();

      const columns = store.db.prepare("PRAGMA table_info(foods)").all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      assert.ok(names.includes("is_correction"));
      assert.ok(names.includes("verified_fields"));

      const backfilled = store.db
        .prepare("SELECT is_correction FROM foods WHERE id = ?")
        .get("web_premigration") as { is_correction: number };
      assert.equal(backfilled.is_correction, 1);
    });
  });
});

import crypto from "node:crypto";

import Database from "better-sqlite3";

import type { FoodItem, RawFoodRow, SearchResult, CacheStats } from "./types.js";
import { MACRO_FIELDS } from "./types.js";
import { toFoodResponse, toSearchResponse } from "./scaling.js";
import type { FoodResponse, SearchResponse } from "./types.js";
import { getDbPath } from "./utils.js";

// Derived (query-time) column: the id of the correction that supersedes a given row, or NULL.
// Reuses the existing `source_id = 'override:<id>'` convention `override()` already writes —
// one convention, read from two angles (is_correction on the correction itself, superseded_by on
// the row it corrects). References the outer row as `f.id`, so every query using it must alias
// the outer `foods` table as `f`.
const SUPERSEDED_BY_SQL =
  "(SELECT o.id FROM foods o WHERE o.source_tier = 'web' AND o.source_id = 'override:' || f.id LIMIT 1) AS superseded_by";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  type TEXT DEFAULT 'everyday',
  ean_13 TEXT,
  source_tier TEXT NOT NULL DEFAULT 'local',
  source_id TEXT NOT NULL,
  source_query TEXT,
  calories REAL,
  protein REAL,
  fat REAL,
  carbs REAL,
  fiber REAL,
  sugar REAL,
  sodium REAL,
  serving_size TEXT,
  serving_weight_g REAL,
  alternate_names_text TEXT,
  labels TEXT,
  ingredients TEXT,
  data_source TEXT,
  is_correction INTEGER NOT NULL DEFAULT 0,
  verified_fields TEXT,
  cached_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_tier, source_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS foods_fts USING fts5(
  name, brand, alternate_names_text,
  content='foods',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS foods_ai AFTER INSERT ON foods BEGIN
  INSERT INTO foods_fts(rowid, name, brand, alternate_names_text)
  VALUES (new.rowid, new.name, new.brand, new.alternate_names_text);
END;

CREATE TRIGGER IF NOT EXISTS foods_ad AFTER DELETE ON foods BEGIN
  INSERT INTO foods_fts(foods_fts, rowid, name, brand, alternate_names_text)
  VALUES ('delete', old.rowid, old.name, old.brand, old.alternate_names_text);
END;

CREATE TRIGGER IF NOT EXISTS foods_au AFTER UPDATE ON foods BEGIN
  INSERT INTO foods_fts(foods_fts, rowid, name, brand, alternate_names_text)
  VALUES ('delete', old.rowid, old.name, old.brand, old.alternate_names_text);
  INSERT INTO foods_fts(rowid, name, brand, alternate_names_text)
  VALUES (new.rowid, new.name, new.brand, new.alternate_names_text);
END;

CREATE INDEX IF NOT EXISTS idx_foods_ean13 ON foods(ean_13) WHERE ean_13 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_foods_source_tier ON foods(source_tier);
`;

export class NutritionStore {
  db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getDbPath();
    this.db = this.openDatabase();
  }

  reopen(): void {
    try { this.db.close(); } catch {}
    this.db = this.openDatabase();
  }

  private openDatabase(): Database.Database {
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    this.migrateSchema(db);
    return db;
  }

  /**
   * Idempotent, additive-only migration for DBs created before is_correction/verified_fields
   * existed (CREATE TABLE IF NOT EXISTS does not add columns to an already-existing table). Safe
   * to run against the live 232MB production DB: no rows are rewritten or dropped, only two
   * nullable/defaulted columns are added, wrapped in a transaction so it never half-applies.
   */
  private migrateSchema(db: Database.Database): void {
    const migrate = db.transaction(() => {
      const columns = db.prepare("PRAGMA table_info(foods)").all() as Array<{ name: string }>;
      const existing = new Set(columns.map((c) => c.name));

      if (!existing.has("is_correction")) {
        db.exec("ALTER TABLE foods ADD COLUMN is_correction INTEGER NOT NULL DEFAULT 0");
        // Deterministic backfill, not a guess: source_id = 'override:<id>' is the pre-existing
        // convention override() already writes, so this retroactively flags already-existing
        // overrides (e.g. a prior correction) as corrections without anyone re-running anything.
        db.exec("UPDATE foods SET is_correction = 1 WHERE source_id LIKE 'override:%'");
      }
      if (!existing.has("verified_fields")) {
        db.exec("ALTER TABLE foods ADD COLUMN verified_fields TEXT");
      }
    });
    migrate();
  }

  search(query: string, limit: number = 10): SearchResponse[] {
    // Sanitize FTS query: strip operators, add prefix matching
    const sanitized = query
      .replace(/[*"(){}[\]^~\\|<>:@!&]/g, "")
      .trim();
    if (!sanitized) return [];

    const terms = sanitized.split(/\s+/).filter(Boolean);
    const ftsQuery = terms.map((t) => `"${t}"*`).join(" ");

    const stmt = this.db.prepare(`
      SELECT f.id, f.name, f.brand, f.calories, f.protein, f.fat, f.carbs,
             f.serving_size, f.serving_weight_g, f.source_tier, f.is_correction,
             f.verified_fields, ${SUPERSEDED_BY_SQL}
      FROM foods_fts fts
      JOIN foods f ON f.rowid = fts.rowid
      WHERE foods_fts MATCH ?
      ORDER BY bm25(foods_fts) ASC
      LIMIT ?
    `);

    const rows = stmt.all(ftsQuery, limit) as SearchResult[];
    return rows.map(toSearchResponse);
  }

  /** Raw canonical row, no response shaping — for internal engine use (e.g. override()
   *  inheritance) that must never see serving-scaled values. */
  private getRawRow(id: string): FoodItem | null {
    const stmt = this.db.prepare("SELECT * FROM foods WHERE id = ?");
    return (stmt.get(id) as FoodItem) ?? null;
  }

  /**
   * The id of the correction that supersedes `id`, or null. Exposed for callers (the search
   * orchestrator's freshly-fetched-USDA path) that build a response from an in-memory object
   * rather than a full row read, so they still reflect a pre-existing correction rather than
   * silently assuming none exists.
   */
  findSupersededBy(id: string): string | null {
    const stmt = this.db.prepare(
      "SELECT id FROM foods WHERE source_tier = 'web' AND source_id = 'override:' || ? LIMIT 1"
    );
    const row = stmt.get(id) as { id: string } | undefined;
    return row?.id ?? null;
  }

  lookup(id: string): FoodResponse | null {
    const stmt = this.db.prepare(
      `SELECT f.*, ${SUPERSEDED_BY_SQL} FROM foods f WHERE f.id = ?`
    );
    const row = (stmt.get(id) as RawFoodRow) ?? null;
    return row ? toFoodResponse(row) : null;
  }

  lookupByBarcode(barcode: string): FoodResponse | null {
    // Severest fix (review finding R2): a correction is always source_tier='web', so ordering by
    // tier alone put it BEHIND the row it corrects — the correction silently never applied.
    // is_correction now ranks first regardless of tier; tier order is only the tiebreak.
    const stmt = this.db.prepare(
      `SELECT f.*, ${SUPERSEDED_BY_SQL} FROM foods f WHERE f.ean_13 = ?
       ORDER BY CASE WHEN f.is_correction = 1 THEN 0 ELSE 1 END,
                CASE f.source_tier WHEN 'local' THEN 0 WHEN 'usda' THEN 1 ELSE 2 END
       LIMIT 1`
    );
    const row = (stmt.get(barcode) as RawFoodRow) ?? null;
    return row ? toFoodResponse(row) : null;
  }

  upsert(food: Omit<FoodItem, "cached_at" | "updated_at">): void {
    const stmt = this.db.prepare(`
      INSERT INTO foods (id, name, brand, type, ean_13, source_tier, source_id,
        source_query, calories, protein, fat, carbs, fiber, sugar, sodium,
        serving_size, serving_weight_g, alternate_names_text, labels,
        ingredients, data_source, is_correction, verified_fields)
      VALUES (@id, @name, @brand, @type, @ean_13, @source_tier, @source_id,
        @source_query, @calories, @protein, @fat, @carbs, @fiber, @sugar, @sodium,
        @serving_size, @serving_weight_g, @alternate_names_text, @labels,
        @ingredients, @data_source, @is_correction, @verified_fields)
      ON CONFLICT(source_tier, source_id) DO UPDATE SET
        name = COALESCE(excluded.name, foods.name),
        brand = COALESCE(excluded.brand, foods.brand),
        type = COALESCE(excluded.type, foods.type),
        ean_13 = COALESCE(excluded.ean_13, foods.ean_13),
        calories = COALESCE(excluded.calories, foods.calories),
        protein = COALESCE(excluded.protein, foods.protein),
        fat = COALESCE(excluded.fat, foods.fat),
        carbs = COALESCE(excluded.carbs, foods.carbs),
        fiber = COALESCE(excluded.fiber, foods.fiber),
        sugar = COALESCE(excluded.sugar, foods.sugar),
        sodium = COALESCE(excluded.sodium, foods.sodium),
        serving_size = COALESCE(excluded.serving_size, foods.serving_size),
        serving_weight_g = COALESCE(excluded.serving_weight_g, foods.serving_weight_g),
        alternate_names_text = COALESCE(excluded.alternate_names_text, foods.alternate_names_text),
        labels = COALESCE(excluded.labels, foods.labels),
        ingredients = COALESCE(excluded.ingredients, foods.ingredients),
        data_source = COALESCE(excluded.data_source, foods.data_source),
        -- Only override() ever writes to the ('web', 'override:<id>') composite key, so no other
        -- upsert caller's conflict path can collide with an override row: safe to overwrite
        -- directly rather than COALESCE (is_correction is NOT NULL, excluded is never actually
        -- missing information here).
        is_correction = excluded.is_correction,
        -- Non-override callers always pass verified_fields: null, meaning "don't touch"; override()
        -- always passes its own pre-merged full array (never null) when updating it.
        verified_fields = COALESCE(excluded.verified_fields, foods.verified_fields),
        updated_at = datetime('now')
    `);

    stmt.run(food);
  }

  insertBulk(
    foods: Array<Omit<FoodItem, "cached_at" | "updated_at">>
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO foods (id, name, brand, type, ean_13, source_tier, source_id,
        source_query, calories, protein, fat, carbs, fiber, sugar, sodium,
        serving_size, serving_weight_g, alternate_names_text, labels,
        ingredients, data_source, is_correction, verified_fields)
      VALUES (@id, @name, @brand, @type, @ean_13, @source_tier, @source_id,
        @source_query, @calories, @protein, @fat, @carbs, @fiber, @sugar, @sodium,
        @serving_size, @serving_weight_g, @alternate_names_text, @labels,
        @ingredients, @data_source, @is_correction, @verified_fields)
    `);

    const tx = this.db.transaction((items: typeof foods) => {
      for (const item of items) {
        stmt.run(item);
      }
    });

    tx(foods);
  }

  getStats(): CacheStats {
    const total = (
      this.db.prepare("SELECT COUNT(*) as count FROM foods").get() as {
        count: number;
      }
    ).count;

    const tiers = this.db
      .prepare(
        "SELECT source_tier, COUNT(*) as count FROM foods GROUP BY source_tier"
      )
      .all() as Array<{ source_tier: string; count: number }>;

    const lastCached = (
      this.db
        .prepare(
          "SELECT cached_at FROM foods ORDER BY cached_at DESC LIMIT 1"
        )
        .get() as { cached_at: string } | undefined
    )?.cached_at ?? null;

    const by_tier = Object.fromEntries(
      tiers.map((t) => [t.source_tier, t.count])
    );

    return { total, by_tier, last_cached_at: lastCached };
  }

  listCached(tier: "usda" | "web" | "all" = "all", limit: number = 20, offset: number = 0): SearchResponse[] {
    const where = tier === "all"
      ? "WHERE f.source_tier IN ('usda', 'web')"
      : "WHERE f.source_tier = ?";
    const stmt = this.db.prepare(`
      SELECT f.id, f.name, f.brand, f.calories, f.protein, f.fat, f.carbs,
             f.serving_size, f.serving_weight_g, f.source_tier, f.is_correction,
             f.verified_fields, ${SUPERSEDED_BY_SQL}
      FROM foods f
      ${where}
      ORDER BY (CASE WHEN f.is_correction = 1 THEN 0 ELSE 1 END), f.updated_at DESC
      LIMIT ? OFFSET ?
    `);
    const params = tier === "all" ? [limit, offset] : [tier, limit, offset];
    const rows = stmt.all(...params) as SearchResult[];
    return rows.map(toSearchResponse);
  }

  delete(id: string): { deleted: boolean; reason?: string } {
    // Refuse to delete local (OpenNutrition) entries — build-db is the authority
    if (id.startsWith("on_")) {
      return { deleted: false, reason: "Cannot delete local dataset entries. Use build-db to rebuild." };
    }
    const stmt = this.db.prepare("DELETE FROM foods WHERE id = ?");
    const result = stmt.run(id);
    if (result.changes === 0) {
      return { deleted: false, reason: "Food not found" };
    }
    return { deleted: true };
  }

  private getRawRowBySourceId(sourceTier: string, sourceId: string): FoodItem | null {
    const stmt = this.db.prepare(
      "SELECT * FROM foods WHERE source_tier = ? AND source_id = ?"
    );
    return (stmt.get(sourceTier, sourceId) as FoodItem) ?? null;
  }

  override(
    id: string,
    fields: Partial<Pick<FoodItem, "name" | "brand" | "calories" | "protein" | "fat" | "carbs" | "fiber" | "sugar" | "sodium" | "serving_size" | "serving_weight_g">>
  ): { overridden: boolean; override_id?: string; reason?: string } {
    // Raw canonical read, never the public (serving-scaled) lookup() — inheriting a scaled
    // per-serving value and writing it back as per-100g would corrupt exactly the class of data
    // this fix exists to correct (review finding, plan review round 5).
    const existing = this.getRawRow(id);
    if (!existing) {
      return { overridden: false, reason: "Food not found" };
    }

    const overrideSourceId = `override:${id}`;
    // Reuse the existing override row's id/verified_fields on a repeat correction (plan review
    // round 5): a freshly generated id is never actually stored once ON CONFLICT fires (the
    // primary key is never in the DO UPDATE SET list), so returning a new id every time silently
    // pointed callers at an id that was never written. Also required for the verified_fields
    // union below — a field verified in an earlier call must not become "unverified" because a
    // later call corrects a different field.
    const priorOverride = this.getRawRowBySourceId("web", overrideSourceId);
    const overrideId = priorOverride?.id ?? NutritionStore.generateId("web");

    const suppliedMacroFields = MACRO_FIELDS.filter((field) => fields[field] !== undefined);
    const priorVerified: string[] = priorOverride?.verified_fields
      ? JSON.parse(priorOverride.verified_fields)
      : [];
    const mergedVerified = Array.from(new Set([...priorVerified, ...suppliedMacroFields]));

    // Unspecified fields inherit from the PRIOR OVERRIDE when one exists, not from the pristine
    // original — otherwise a second partial correction silently reverts every field it doesn't
    // touch back to the uncorrected original value, while verified_fields still (correctly)
    // claims that field is verified (code review round 2, P1: "correcting calories first and
    // protein later resets calories back to the original value"). Metadata fields that the
    // override tool never lets a caller change (type, ean_13, source_query,
    // alternate_names_text, labels, ingredients) still come from `existing` — they're identical
    // between existing and priorOverride by construction, so this is just the simpler read.
    const inheritFrom = priorOverride ?? existing;

    this.upsert({
      id: overrideId,
      name: fields.name ?? inheritFrom.name,
      brand: fields.brand ?? inheritFrom.brand,
      type: existing.type,
      ean_13: existing.ean_13,
      source_tier: "web",
      source_id: overrideSourceId,
      source_query: existing.source_query,
      calories: fields.calories ?? inheritFrom.calories,
      protein: fields.protein ?? inheritFrom.protein,
      fat: fields.fat ?? inheritFrom.fat,
      carbs: fields.carbs ?? inheritFrom.carbs,
      fiber: fields.fiber ?? inheritFrom.fiber,
      sugar: fields.sugar ?? inheritFrom.sugar,
      sodium: fields.sodium ?? inheritFrom.sodium,
      serving_size: fields.serving_size ?? inheritFrom.serving_size,
      serving_weight_g: fields.serving_weight_g ?? inheritFrom.serving_weight_g,
      alternate_names_text: existing.alternate_names_text,
      labels: existing.labels,
      ingredients: existing.ingredients,
      data_source: JSON.stringify({ source: "override", original_id: id }),
      is_correction: 1,
      verified_fields: mergedVerified.length > 0 ? JSON.stringify(mergedVerified) : null,
    });

    return { overridden: true, override_id: overrideId };
  }

  static generateId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  close(): void {
    this.db.close();
  }
}

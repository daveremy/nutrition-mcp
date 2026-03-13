import crypto from "node:crypto";

import Database from "better-sqlite3";

import type { FoodItem, SearchResult, CacheStats } from "./types.js";
import { getDbPath } from "./utils.js";

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
    return db;
  }

  search(query: string, limit: number = 10): SearchResult[] {
    // Sanitize FTS query: strip operators, add prefix matching
    const sanitized = query
      .replace(/[*"(){}[\]^~\\|<>:@!&]/g, "")
      .trim();
    if (!sanitized) return [];

    const terms = sanitized.split(/\s+/).filter(Boolean);
    const ftsQuery = terms.map((t) => `"${t}"*`).join(" ");

    const stmt = this.db.prepare(`
      SELECT f.id, f.name, f.brand, f.calories, f.protein, f.fat, f.carbs,
             f.serving_size, f.source_tier
      FROM foods_fts fts
      JOIN foods f ON f.rowid = fts.rowid
      WHERE foods_fts MATCH ?
      ORDER BY bm25(foods_fts) ASC
      LIMIT ?
    `);

    return stmt.all(ftsQuery, limit) as SearchResult[];
  }

  lookup(id: string): FoodItem | null {
    const stmt = this.db.prepare("SELECT * FROM foods WHERE id = ?");
    return (stmt.get(id) as FoodItem) ?? null;
  }

  lookupByBarcode(barcode: string): FoodItem | null {
    const stmt = this.db.prepare(
      "SELECT * FROM foods WHERE ean_13 = ? ORDER BY CASE source_tier WHEN 'local' THEN 0 WHEN 'usda' THEN 1 ELSE 2 END LIMIT 1"
    );
    return (stmt.get(barcode) as FoodItem) ?? null;
  }

  upsert(food: Omit<FoodItem, "cached_at" | "updated_at">): void {
    const stmt = this.db.prepare(`
      INSERT INTO foods (id, name, brand, type, ean_13, source_tier, source_id,
        source_query, calories, protein, fat, carbs, fiber, sugar, sodium,
        serving_size, serving_weight_g, alternate_names_text, labels,
        ingredients, data_source)
      VALUES (@id, @name, @brand, @type, @ean_13, @source_tier, @source_id,
        @source_query, @calories, @protein, @fat, @carbs, @fiber, @sugar, @sodium,
        @serving_size, @serving_weight_g, @alternate_names_text, @labels,
        @ingredients, @data_source)
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
        ingredients, data_source)
      VALUES (@id, @name, @brand, @type, @ean_13, @source_tier, @source_id,
        @source_query, @calories, @protein, @fat, @carbs, @fiber, @sugar, @sodium,
        @serving_size, @serving_weight_g, @alternate_names_text, @labels,
        @ingredients, @data_source)
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

  override(
    id: string,
    fields: Partial<Pick<FoodItem, "name" | "brand" | "calories" | "protein" | "fat" | "carbs" | "fiber" | "sugar" | "sodium" | "serving_size" | "serving_weight_g">>
  ): { overridden: boolean; override_id?: string; reason?: string } {
    const existing = this.lookup(id);
    if (!existing) {
      return { overridden: false, reason: "Food not found" };
    }

    // Create a web-tier override that inherits all fields from the original,
    // with user-provided fields taking precedence
    const overrideId = NutritionStore.generateId("web");
    const overrideSourceId = `override:${id}`;

    this.upsert({
      id: overrideId,
      name: fields.name ?? existing.name,
      brand: fields.brand ?? existing.brand,
      type: existing.type,
      ean_13: existing.ean_13,
      source_tier: "web",
      source_id: overrideSourceId,
      source_query: existing.source_query,
      calories: fields.calories ?? existing.calories,
      protein: fields.protein ?? existing.protein,
      fat: fields.fat ?? existing.fat,
      carbs: fields.carbs ?? existing.carbs,
      fiber: fields.fiber ?? existing.fiber,
      sugar: fields.sugar ?? existing.sugar,
      sodium: fields.sodium ?? existing.sodium,
      serving_size: fields.serving_size ?? existing.serving_size,
      serving_weight_g: fields.serving_weight_g ?? existing.serving_weight_g,
      alternate_names_text: existing.alternate_names_text,
      labels: existing.labels,
      ingredients: existing.ingredients,
      data_source: JSON.stringify({ source: "override", original_id: id }),
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

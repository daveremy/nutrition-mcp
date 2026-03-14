import fs, { createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";

import { setSeedPhase, setSeedInserted } from "./seed-state.js";
import { getDbDir, getDbPath, log, normalizeBarcode } from "./utils.js";

const DATASET_URL =
  "https://github.com/daveremy/nutrition-mcp/releases/download/dataset-v2025.1/opennutrition-dataset-2025.1.zip";

// Schema without FTS triggers (faster bulk import)
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

CREATE INDEX IF NOT EXISTS idx_foods_ean13 ON foods(ean_13) WHERE ean_13 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_foods_source_tier ON foods(source_tier);
`;

const FTS_SCHEMA = `
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
`;

interface TsvRow {
  [key: string]: string;
}

function safeJsonParse(val: string | undefined): any {
  if (!val || val === "") return null;
  try { return JSON.parse(val); } catch { return null; }
}

function mapTsvRow(row: TsvRow) {
  const name = row["name"]?.trim();
  if (!name) return null;

  const sourceId = row["id"] || null;
  if (!sourceId) return null;

  const barcode = row["ean_13"] ? normalizeBarcode(row["ean_13"]) : null;

  // Parse nutrition_100g JSON
  const nutrition = safeJsonParse(row["nutrition_100g"]);

  // Parse alternate_names JSON array to space-separated text
  const altNamesArr = safeJsonParse(row["alternate_names"]);
  const altNamesText = Array.isArray(altNamesArr) && altNamesArr.length > 0
    ? altNamesArr.join(" ")
    : null;

  // Parse serving JSON for serving size
  const serving = safeJsonParse(row["serving"]);
  let servingSize: string | null = null;
  let servingWeightG: number | null = null;
  if (serving?.common) {
    servingSize = `${serving.common.quantity} ${serving.common.unit}`;
    if (serving.metric?.unit === "g") {
      servingWeightG = serving.metric.quantity ?? null;
    }
  }

  return {
    id: `on_${sourceId}`,
    name,
    brand: null,
    type: row["type"]?.trim() || "everyday",
    ean_13: barcode,
    source_tier: "local",
    source_id: sourceId,
    source_query: null,
    calories: nutrition?.calories ?? null,
    protein: nutrition?.protein ?? null,
    fat: nutrition?.total_fat ?? null,
    carbs: nutrition?.carbohydrates ?? null,
    fiber: nutrition?.dietary_fiber ?? null,
    sugar: nutrition?.total_sugars ?? null,
    sodium: nutrition?.sodium ?? null, // already in mg
    serving_size: servingSize,
    serving_weight_g: servingWeightG,
    alternate_names_text: altNamesText,
    labels: row["labels"] ? row["labels"] : null, // already JSON array string
    ingredients: row["ingredients"]?.trim() || null,
    data_source: JSON.stringify({ source: "open_nutrition", id: sourceId }),
  };
}

async function downloadAndExtractTsv(destDir: string): Promise<string> {
  const zipPath = path.join(destDir, "dataset.zip");
  const tsvPath = path.join(destDir, "dataset.tsv");

  // Skip download if TSV already exists
  if (fs.existsSync(tsvPath)) {
    log("Using cached TSV file");
    return tsvPath;
  }

  log(`Downloading dataset (~60MB)...`);
  const res = await fetch(DATASET_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status}`);
  }

  // Save zip
  const writeStream = createWriteStream(zipPath);
  await pipeline(Readable.fromWeb(res.body as any), writeStream);
  setSeedPhase("extracting");
  log("Download complete, extracting...");

  // Extract using yauzl
  const yauzl = await import("yauzl");

  return new Promise<string>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err: Error | null, zipfile: any) => {
      if (err) return reject(err);

      zipfile.readEntry();
      zipfile.on("entry", (entry: any) => {
        if (entry.fileName.endsWith(".tsv")) {
          zipfile.openReadStream(entry, (err2: Error | null, readStream: any) => {
            if (err2) return reject(err2);
            const out = createWriteStream(tsvPath);
            readStream.pipe(out);
            out.on("finish", () => {
              log("Extraction complete");
              resolve(tsvPath);
            });
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on("end", () => {
        if (!fs.existsSync(tsvPath)) {
          reject(new Error("No TSV file found in zip"));
        }
      });
    });
  });
}

export async function seedDatabase(): Promise<void> {
  setSeedInserted(0);
  setSeedPhase("downloading");
  const dbDir = getDbDir();
  const dbPath = getDbPath();
  const tmpDbPath = dbPath + ".tmp";

  // Download and extract
  const tsvPath = await downloadAndExtractTsv(dbDir);

  // Build temp DB
  log("Building database...");
  if (fs.existsSync(tmpDbPath)) {
    fs.unlinkSync(tmpDbPath);
  }

  const db = new Database(tmpDbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);

  // Bulk insert — stream TSV line-by-line to avoid loading entire file into memory
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO foods (id, name, brand, type, ean_13, source_tier, source_id,
      source_query, calories, protein, fat, carbs, fiber, sugar, sodium,
      serving_size, serving_weight_g, alternate_names_text, labels,
      ingredients, data_source)
    VALUES (@id, @name, @brand, @type, @ean_13, @source_tier, @source_id,
      @source_query, @calories, @protein, @fat, @carbs, @fiber, @sugar, @sodium,
      @serving_size, @serving_weight_g, @alternate_names_text, @labels,
      @ingredients, @data_source)
  `);

  // Stream TSV line-by-line and insert in batches to limit memory usage
  setSeedPhase("importing");
  log("Importing foods...");
  const BATCH_SIZE = 10000;
  let headers: string[] = [];
  let batch: TsvRow[] = [];
  let lineNum = 0;
  let inserted = 0;

  const insertBatch = db.transaction((mapped: NonNullable<ReturnType<typeof mapTsvRow>>[]) => {
    for (let i = 0; i < mapped.length; i++) {
      try {
        stmt.run(mapped[i]);
        inserted++;
      } catch {
        // Skip rows that fail (e.g. duplicate IDs)
      }
    }
  });

  const rl = readline.createInterface({
    input: createReadStream(tsvPath, "utf-8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (lineNum === 0) {
      headers = line.split("\t");
      lineNum++;
      continue;
    }
    if (!line.trim()) { lineNum++; continue; }

    const values = line.split("\t");
    const row: TsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    batch.push(row);
    lineNum++;

    if (batch.length >= BATCH_SIZE) {
      // Map outside the transaction to avoid JSON parsing under the write lock
      const mapped = batch.map(mapTsvRow).filter((r): r is NonNullable<typeof r> => r !== null);
      insertBatch(mapped);
      setSeedInserted(inserted);
      batch = [];
      if (inserted % 50000 < BATCH_SIZE) {
        log(`  ${inserted.toLocaleString()} foods imported...`);
      }
    }
  }

  // Insert remaining rows
  if (batch.length > 0) {
    const mapped = batch.map(mapTsvRow).filter((r): r is NonNullable<typeof r> => r !== null);
    insertBatch(mapped);
  }

  if (lineNum <= 1) throw new Error("Empty TSV file");
  log(`Imported ${inserted.toLocaleString()} foods`);

  // Preserve cached data from existing DB before building FTS index
  if (fs.existsSync(dbPath)) {
    log("Preserving cached USDA/web data...");
    try {
      db.exec(`ATTACH DATABASE '${dbPath}' AS old_db`);
      db.exec(`
        INSERT OR IGNORE INTO foods
        SELECT * FROM old_db.foods
        WHERE source_tier IN ('usda', 'web')
      `);
      db.exec("DETACH DATABASE old_db");
      log("Cached data preserved");
    } catch (err) {
      log("Warning: could not preserve cached data:", err);
    }
  }

  // Create FTS and rebuild index (after all data including cached entries)
  setSeedPhase("indexing");
  log("Building search index...");
  db.exec(FTS_SCHEMA);
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES ('rebuild')");

  db.close();

  // Replace existing DB (remove first for Windows compatibility)
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  fs.renameSync(tmpDbPath, dbPath);
  setSeedInserted(inserted);
  setSeedPhase("done");
  log(`Database ready (${dbPath})`);

  // Clean up zip file (keep TSV for faster rebuilds)
  const zipPath = path.join(dbDir, "dataset.zip");
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
}


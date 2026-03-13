import fs, { createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";

import { getDbDir, getDbPath, normalizeBarcode } from "./utils.js";

const DATASET_URL =
  "https://github.com/nicholasgasior/open-nutrition-database/releases/download/v2.0.0/en.openfoodfacts.org.products.tsv.zip";

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

function parseNumber(val: string | undefined): number | null {
  if (!val || val === "" || val === "NA") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function mapTsvRow(row: TsvRow, index: number) {
  const name = row["product_name"]?.trim();
  if (!name) return null;

  const sourceId = row["code"] || `row_${index}`;
  const barcode = row["code"] ? normalizeBarcode(row["code"]) : null;

  // Build alternate names text from various name columns
  const altNames: string[] = [];
  if (row["generic_name"]) altNames.push(row["generic_name"]);
  if (row["abbreviated_product_name"]) altNames.push(row["abbreviated_product_name"]);

  return {
    id: `on_${sourceId}`,
    name,
    brand: row["brands"]?.trim() || null,
    type: "everyday",
    ean_13: barcode,
    source_tier: "local",
    source_id: sourceId,
    source_query: null,
    calories: parseNumber(row["energy-kcal_100g"]),
    protein: parseNumber(row["proteins_100g"]),
    fat: parseNumber(row["fat_100g"]),
    carbs: parseNumber(row["carbohydrates_100g"]),
    fiber: parseNumber(row["fiber_100g"]),
    sugar: parseNumber(row["sugars_100g"]),
    sodium: (() => {
      const s = parseNumber(row["sodium_100g"]);
      return s !== null ? s * 1000 : null; // convert g to mg
    })(),
    serving_size: row["serving_size"]?.trim() || null,
    serving_weight_g: parseNumber(row["serving_quantity"]),
    alternate_names_text: altNames.length > 0 ? altNames.join(" ") : null,
    labels: row["labels"] ? JSON.stringify(row["labels"].split(",").map((l: string) => l.trim())) : null,
    ingredients: row["ingredients_text"]?.trim() || null,
    data_source: JSON.stringify({ source: "open_nutrition", code: row["code"] }),
  };
}

async function downloadAndExtractTsv(destDir: string): Promise<string> {
  const zipPath = path.join(destDir, "dataset.zip");
  const tsvPath = path.join(destDir, "dataset.tsv");

  // Skip download if TSV already exists
  if (fs.existsSync(tsvPath)) {
    console.log("Using cached TSV file");
    return tsvPath;
  }

  console.log(`Downloading dataset from ${DATASET_URL}...`);
  const res = await fetch(DATASET_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status}`);
  }

  // Save zip
  const writeStream = createWriteStream(zipPath);
  await pipeline(Readable.fromWeb(res.body as any), writeStream);
  console.log("Download complete, extracting...");

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
              console.log("Extraction complete");
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
  const dbDir = getDbDir();
  const dbPath = getDbPath();
  const tmpDbPath = dbPath + ".tmp";

  // Download and extract
  const tsvPath = await downloadAndExtractTsv(dbDir);

  // Build temp DB
  console.log("Building database...");
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
  console.log("Parsing and inserting...");
  const BATCH_SIZE = 10000;
  let headers: string[] = [];
  let batch: TsvRow[] = [];
  let lineNum = 0;
  let inserted = 0;

  const insertBatch = db.transaction((rows: TsvRow[]) => {
    for (let i = 0; i < rows.length; i++) {
      const mapped = mapTsvRow(rows[i], lineNum - rows.length + i);
      if (!mapped) continue;
      try {
        stmt.run(mapped);
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
      insertBatch(batch);
      batch = [];
    }
  }

  // Insert remaining rows
  if (batch.length > 0) {
    insertBatch(batch);
  }

  if (headers.length === 0) throw new Error("Empty TSV file");
  console.log(`Inserted ${inserted} foods`);

  // Create FTS and rebuild index
  console.log("Building FTS index...");
  db.exec(FTS_SCHEMA);
  db.exec("INSERT INTO foods_fts(foods_fts) VALUES ('rebuild')");

  // Preserve cached data from existing DB
  if (fs.existsSync(dbPath)) {
    console.log("Preserving cached USDA/web data from existing database...");
    try {
      db.exec(`ATTACH DATABASE '${dbPath}' AS old_db`);
      db.exec(`
        INSERT OR IGNORE INTO foods
        SELECT * FROM old_db.foods
        WHERE source_tier IN ('usda', 'web')
      `);
      db.exec("DETACH DATABASE old_db");
      console.log("Cached data preserved");
    } catch (err) {
      console.error("Warning: could not preserve cached data:", err);
    }
  }

  db.close();

  // Replace existing DB (remove first for Windows compatibility)
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  fs.renameSync(tmpDbPath, dbPath);
  console.log(`Database ready at ${dbPath}`);

  // Clean up zip file (keep TSV for faster rebuilds)
  const zipPath = path.join(dbDir, "dataset.zip");
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
}


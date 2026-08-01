import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getDbDir(): string {
  const dir = path.join(os.homedir(), ".nutrition-mcp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbPath(): string {
  return path.join(getDbDir(), "nutrition.db");
}

/** Rounds `value` to `decimals` decimal places. Shared by src/scaling.ts (per-field label
 *  rounding) and src/serving-parse.ts (derived-weight rounding). */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function log(msg: string, err?: unknown): void {
  if (err !== undefined) {
    console.error(`[nutrition-mcp] ${msg}`, err);
  } else {
    console.error(`[nutrition-mcp] ${msg}`);
  }
}

/**
 * Normalize a barcode to 13-digit EAN-13.
 * If 12 digits (UPC-A), zero-pad to 13.
 * Returns null if the barcode is not 12 or 13 digits.
 */
export function normalizeBarcode(barcode: string): string | null {
  const cleaned = barcode.replace(/\D/g, "");
  if (cleaned.length === 12) {
    return "0" + cleaned;
  }
  if (cleaned.length === 13) {
    return cleaned;
  }
  return null;
}

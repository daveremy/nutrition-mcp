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

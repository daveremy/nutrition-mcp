import type { SearchResponse } from "./types.js";

// Side-effect-free by design (plan review round 1, codex): cli.ts ends with an unconditional
// program.parseAsync(), so importing it directly from a test would execute the CLI. This
// module has no Commander dependency and can be imported/tested in isolation.

const NAME_WIDTH = 40;
// Visible regardless of which basis group a row lands in — put the signal where a careless
// read can't drop it (the name column is always read first), matching the header-carries-the-
// unit philosophy the rest of this fix uses (#9).
const CORRUPT_MARKER = "⚠ "; // "⚠ "

function fmt(n: number | null | undefined): string {
  return n != null ? n.toFixed(1) : "-";
}

interface MacroHeaders {
  cal: string;
  pro: string;
  fat: string;
  carb: string;
}

/**
 * Header text reflects the basis (#9's preferred fix, over a separate advisory column) so the
 * unit is in the label itself rather than something a careless reader can skip past — a bare
 * "Cal" header with no basis indication is exactly how the CLI silently reintroduced the
 * pre-0.4.0 per-100g-shown-as-per-serving bug on this one surface.
 */
function macroHeaders(basis: "per_serving" | "per_100g"): MacroHeaders {
  const suffix = basis === "per_100g" ? "/100g" : "";
  return {
    cal: `Cal${suffix}`,
    pro: `Pro${suffix}`,
    fat: `Fat${suffix}`,
    carb: `Carb${suffix}`,
  };
}

function renderGroup(results: SearchResponse[], basis: "per_serving" | "per_100g"): string {
  const headers = macroHeaders(basis);
  const colWidth = Math.max(6, headers.cal.length, headers.pro.length, headers.fat.length, headers.carb.length);
  const lines: string[] = [];

  lines.push(
    "Name".padEnd(NAME_WIDTH) +
      headers.cal.padStart(colWidth) +
      headers.pro.padStart(colWidth) +
      headers.fat.padStart(colWidth) +
      headers.carb.padStart(colWidth) +
      "  Tier"
  );
  lines.push("-".repeat(NAME_WIDTH + colWidth * 4 + 6));

  for (const r of results) {
    const baseName = r.brand ? `${r.name} (${r.brand})` : r.name;
    // Corrupt rows (#10's mass-conservation guard) must stay visibly marked no matter which
    // basis group they land in — a caller must not be able to miss it by skimming numbers.
    const displayName = r.data_quality === "impossible_macros" ? `${CORRUPT_MARKER}${baseName}` : baseName;
    const name = displayName.slice(0, NAME_WIDTH - 1);
    lines.push(
      name.padEnd(NAME_WIDTH) +
        fmt(r.calories).padStart(colWidth) +
        fmt(r.protein).padStart(colWidth) +
        fmt(r.fat).padStart(colWidth) +
        fmt(r.carbs).padStart(colWidth) +
        `  ${r.source_tier}`
    );
  }

  return lines.join("\n");
}

/**
 * Formats a search result set for CLI display. Partitions by `basis` and prints a
 * separately-labeled table per basis group when a result set is mixed (a plausible outcome —
 * e.g. an oil result stays `per_100g` while everything else around it resolves a serving
 * weight), so the unit is never ambiguous no matter how many bases are present in one query.
 */
export function formatSearchTable(results: SearchResponse[]): string {
  if (results.length === 0) return "No results found.";

  const perServing = results.filter((r) => r.basis === "per_serving");
  const perHundredG = results.filter((r) => r.basis === "per_100g");

  if (perHundredG.length === 0) {
    return renderGroup(perServing, "per_serving");
  }
  if (perServing.length === 0) {
    return renderGroup(perHundredG, "per_100g");
  }

  return [
    "Per serving:",
    renderGroup(perServing, "per_serving"),
    "",
    "Per 100g (unscaled):",
    renderGroup(perHundredG, "per_100g"),
  ].join("\n");
}

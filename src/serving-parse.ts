import type { WeightSource } from "./types.js";
import { roundTo } from "./utils.js";

export interface ParsedServingWeight {
  weight_g: number;
  weight_source: Exclude<WeightSource, "column">;
}

// Tier B — deterministic mass conversion.
const G_PER_OZ = 28.3495;

// Tier C — volumetric conversions. These use FDA nutrition-label rounding conventions rather
// than physical measuring-cup precision (236.588 mL) — 1 cup = 240 mL, 1 tbsp = 15 mL, 1 tsp =
// 5 mL, 1 fl oz = 30 mL. This isn't arbitrary: the live DB's own volumetric NULL-weight strings
// include literal "240 ml", "15 ml", and "30 ml" buckets alongside "1 cup"/"1 tbsp"/"8 oz fl"
// style entries for equivalent servings, so these constants keep a "1 tbsp" row and a "15 ml"
// row for a similar product resolving to the same derived weight.
const ML_PER_CUP = 240;
const ML_PER_TBSP = 15;
const ML_PER_TSP = 5;
const ML_PER_FLOZ = 30;

// Tier A — explicit grams. Zero ambiguity: the number IS the weight.
const GRAMS_RE = /^(\d+(?:\.\d+)?)\s*(?:grams?|grm|g)$/i;

// Tier C — fluid ounces. Checked BEFORE the plain-ounce (mass) regex below for defense in
// depth, even though the literal "fl" token between the number and "oz" already makes the mass
// regex fail its anchored match on its own. "fl oz" is VOLUME, not mass — the issue explicitly
// calls out this conflation as the dangerous one (a mass ounce is ~28.35g; a fluid ounce of
// water is ~29.57g, close enough to be plausible-looking and wrong for anything denser or
// lighter than water). Kept as its own explicit tier so it's never reachable through Tier B.
const FLOZ_RE = /^(\d+(?:\.\d+)?)\s*fl\.?\s*oz$/i;

// Tier B — mass ounces. Does NOT match "8 fl oz" (see FLOZ_RE above, checked first).
const OUNCES_RE = /^(\d+(?:\.\d+)?)\s*oz$/i;

// Tier C — remaining volumetric units. Density is assumed to be 1.0 g/mL (water-like), which is
// safe for the overwhelming majority shape of this dataset's volumetric NULLs (broth, milk,
// juice, canned/bottled drinks) and wrong for oils (~0.92) and honey (~1.4). Flagged via
// weight_source: "parsed_volume" rather than gated on food-type/name heuristics — see the PR
// description for why (name-based gating is itself an unvalidated guess; an explicit,
// machine-checkable weaker signal lets the caller decide, matching the basis/atwater_delta_pct/
// verified_fields philosophy this server already uses).
const ML_RE = /^(\d+(?:\.\d+)?)\s*(?:ml|milliliters?|millilitres?)$/i;
const LITER_RE = /^(\d+(?:\.\d+)?)\s*l(?:iters?|itres?)?$/i;
const CUP_RE = /^(\d+(?:\.\d+)?)\s*cups?$/i;
const TBSP_RE = /^(\d+(?:\.\d+)?)\s*(?:tbsp|tablespoons?)$/i;
const TSP_RE = /^(\d+(?:\.\d+)?)\s*(?:tsp|teaspoons?)$/i;

/**
 * Derives a serving weight in grams from a free-text `serving_size` string, when the
 * `serving_weight_g` column is NULL. Returns null (never a guess) for anything that isn't
 * confidently parseable — e.g. "1 bottle", "1 can". See docs/CALLER-GUIDE.md for how callers
 * should weight `weight_source` on the result.
 */
export function parseServingWeight(
  servingSize: string | null | undefined
): ParsedServingWeight | null {
  if (!servingSize) return null;
  const trimmed = servingSize.trim();
  if (!trimmed) return null;

  let match = trimmed.match(GRAMS_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: n, weight_source: "parsed_grams" } : null;
  }

  match = trimmed.match(FLOZ_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n * ML_PER_FLOZ, 2), weight_source: "parsed_volume" } : null;
  }

  match = trimmed.match(OUNCES_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n * G_PER_OZ, 2), weight_source: "parsed_mass" } : null;
  }

  match = trimmed.match(ML_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n, 2), weight_source: "parsed_volume" } : null;
  }

  match = trimmed.match(LITER_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n * 1000, 2), weight_source: "parsed_volume" } : null;
  }

  match = trimmed.match(CUP_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n * ML_PER_CUP, 2), weight_source: "parsed_volume" } : null;
  }

  match = trimmed.match(TBSP_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n * ML_PER_TBSP, 2), weight_source: "parsed_volume" } : null;
  }

  match = trimmed.match(TSP_RE);
  if (match) {
    const n = Number(match[1]);
    return n > 0 ? { weight_g: roundTo(n * ML_PER_TSP, 2), weight_source: "parsed_volume" } : null;
  }

  return null;
}

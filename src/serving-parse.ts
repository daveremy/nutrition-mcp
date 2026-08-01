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
// juice, canned/bottled drinks) and meaningfully wrong for oils (~0.92 g/mL) and honey/syrup
// (~1.4 g/mL) — verified against a real product (Bertolli EVOO, see the money fixture in
// test/scaling.test.ts). Foods matching `isDensitySensitiveFood` below never reach this tier at
// all (see resolveWeight() in scaling.ts) — they fall back to the honest `per_100g` basis
// instead of a confidently wrong per-serving number. For everything else, the result carries
// `weight_source: "parsed_volume"` so the caller can still tell it apart from a stated weight.
const ML_RE = /^(\d+(?:\.\d+)?)\s*(?:ml|milliliters?|millilitres?)$/i;
const LITER_RE = /^(\d+(?:\.\d+)?)\s*l(?:iters?|itres?)?$/i;
const CUP_RE = /^(\d+(?:\.\d+)?)\s*cups?$/i;
const TBSP_RE = /^(\d+(?:\.\d+)?)\s*(?:tbsp|tablespoons?)$/i;
const TSP_RE = /^(\d+(?:\.\d+)?)\s*(?:tsp|teaspoons?)$/i;

// Foods whose real density is far enough from water (1.0 g/mL) that Tier C's volumetric
// assumption would be a meaningfully wrong headline number, not just an imprecise one — oil
// (~0.92 g/mL, ~8% off) and honey/syrup/molasses (~1.4 g/mL, ~40% off) are the two categories
// the issue names explicitly. Deliberately narrow and unambiguous: each keyword names a food
// that IS that substance (or almost entirely composed of it) whenever it appears in a name, not
// a food that merely contains some of it (so e.g. "salad dressing" or "cream" — far more
// variable in fat content — are NOT included; a false negative there just falls through to the
// same Tier C behavior every other volumetric food gets, while a false positive here wrongly
// demotes a perfectly safe food to per_100g, which is the direction of error that costs less).
const DENSITY_SENSITIVE_RE =
  /\b(oil|honey|syrup|molasses|butter|margarine|shortening|lard|ghee)\b/i;

/**
 * True when `name` names a food dense/light enough that Tier C's 1.0 g/mL assumption would be
 * meaningfully wrong (see DENSITY_SENSITIVE_RE above). Used to suppress Tier C derivation for
 * these foods — they fall back to the honest `per_100g` basis instead of a confidently wrong
 * per-serving number.
 */
export function isDensitySensitiveFood(name: string | null | undefined): boolean {
  if (!name) return false;
  return DENSITY_SENSITIVE_RE.test(name);
}

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

import type {
  DataQuality,
  FoodResponse,
  MacroField,
  RawFoodRow,
  SearchResponse,
  SearchResult,
  WeightSource,
} from "./types.js";
import { IMPOSSIBLE_MACROS, MACRO_FIELDS } from "./types.js";
import { parseServingWeight, isDensitySensitiveFood } from "./serving-parse.js";
import { roundTo } from "./utils.js";

// Fields that are integer-ish in real-world label precision — 1 decimal place implies false
// precision (sodium in mg, calories in kcal are never reported fractionally on a label).
const ROUND_INT_FIELDS: ReadonlySet<MacroField> = new Set(["calories", "sodium"]);

function roundField(field: MacroField, value: number): number {
  return roundTo(value, ROUND_INT_FIELDS.has(field) ? 0 : 1);
}

/**
 * Mass-conservation guard (#10): protein + carbs + fat cannot physically exceed 100g inside
 * 100g of food — the parts cannot outweigh the whole. This needs no domain knowledge (unlike
 * a calorie-ceiling check, which would need to know whether 900 cal/100g is plausible — chia
 * oil legitimately reads 992) and has no false positives: it's arithmetic, not nutrition.
 *
 * Strict `>`, no epsilon: a row summing to exactly 100 is physically valid (pure macro, zero
 * water/ash/fiber-that's-not-carbs) and must not be flagged; 100.1 is impossible and must be.
 */
export const MASS_CONSERVATION_LIMIT_G = 100;

/**
 * Sum of protein+carbs+fat per 100g, treating a missing field as 0 for summing purposes (a
 * row can be corrupt even with one macro unset — e.g. protein+carbs alone already exceeding
 * 100g doesn't get "less corrupt" because fat wasn't recorded). Returns null only when all
 * three are null — nothing to sum, so nothing to judge.
 */
export function computeMacroMassSum(
  protein: number | null | undefined,
  carbs: number | null | undefined,
  fat: number | null | undefined
): number | null {
  if (protein == null && carbs == null && fat == null) return null;
  return (protein ?? 0) + (carbs ?? 0) + (fat ?? 0);
}

// Single source of truth for the ">100" comparison (refine pass, code reuse/quality review):
// both the public hasImpossibleMacros() and computeBasis() below — which also needs the raw
// sum for macro_mass_g, not just the boolean — go through this rather than each re-writing
// the threshold check.
function exceedsMassLimit(sum: number | null): boolean {
  return sum != null && sum > MASS_CONSERVATION_LIMIT_G;
}

/** True when a row's stored per-100g macros are physically impossible (see above). */
export function hasImpossibleMacros(
  protein: number | null | undefined,
  carbs: number | null | undefined,
  fat: number | null | undefined
): boolean {
  return exceedsMassLimit(computeMacroMassSum(protein, carbs, fat));
}

function parseVerifiedFields(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atwater plausibility delta: how far stated calories diverge from what protein/carbs/fat imply
 * (4 kcal/g protein, 4 kcal/g carbs, 9 kcal/g fat). Computed from canonical per-100g values, never
 * from scaled/rounded ones, so it isn't noise from serving-scaling. A signed percentage, not a
 * binary flag — fibre/sugar-alcohol-heavy foods (protein bars, the exact category that caused the
 * bug this fixes) legitimately diverge, and a binary "suspect" flag trains callers to ignore it.
 */
function computeAtwaterDeltaPct(
  calories: number | null,
  protein: number | null,
  fat: number | null,
  carbs: number | null
): number | null {
  if (calories == null || protein == null || fat == null || carbs == null) return null;
  const atwaterKcal = 4 * protein + 4 * carbs + 9 * fat;
  if (atwaterKcal === 0) return null;
  return roundTo(((calories - atwaterKcal) / atwaterKcal) * 100, 1);
}

interface BasisInput {
  serving_weight_g: number | null;
  serving_size?: string | null;
  is_correction?: number;
  verified_fields?: string | null;
  superseded_by?: string | null;
  name?: string;
}

interface BasisFields {
  basis: "per_serving" | "per_100g";
  basis_weight_g: number | null;
  weight_source: WeightSource | null;
  per_100g: Partial<Record<MacroField, number | null>>;
  atwater_delta_pct: number | null;
  is_correction: boolean;
  verified_fields: string[] | null;
  superseded_by: string | null;
  data_quality: DataQuality;
  macro_mass_g: number | null;
}

/**
 * Resolves the weight to scale by, and where it came from. The stored `serving_weight_g`
 * column is always trusted first ("column"); only when it's NULL/0 do we fall back to parsing
 * `serving_size` (#5) — a derived weight must never silently look the same as a stated one, so
 * every non-null result reports which tier produced it.
 *
 * Tier C (volumetric) parses are suppressed for foods whose name matches a known
 * density-sensitive category (oil, honey, syrup, etc.) — see `isDensitySensitiveFood` in
 * serving-parse.ts. A 1.0 g/mL guess is wrong enough on those foods (an oil at 0.92 g/mL, honey
 * at 1.4 g/mL) that the honest `per_100g` fallback is the safer default; unlike Tier A/B, Tier C
 * involves an assumption, not a fact, so it's the only tier that gets gated (code review round
 * 1, P1 — see /tmp/review-5/REVIEW.md).
 */
function resolveWeight(
  servingWeightG: number | null | undefined,
  servingSize: string | null | undefined,
  name: string | null | undefined
): { weight: number | null; weight_source: WeightSource | null } {
  if (servingWeightG != null && servingWeightG > 0) {
    return { weight: servingWeightG, weight_source: "column" };
  }
  const parsed = parseServingWeight(servingSize);
  if (parsed) {
    if (parsed.weight_source === "parsed_volume" && isDensitySensitiveFood(name)) {
      return { weight: null, weight_source: null };
    }
    return { weight: parsed.weight_g, weight_source: parsed.weight_source };
  }
  return { weight: null, weight_source: null };
}

/**
 * The one shared scaling computation applied at every public read boundary (store.search,
 * store.lookup, store.lookupByBarcode, store.listCached, and the orchestrator's freshly-fetched
 * USDA path) so no read path can independently reinvent — or skip — the fix.
 *
 * Only macro fields present (not undefined) on `row` are scaled/returned, so a lean row shape
 * (e.g. search's 4-macro SELECT) doesn't grow fields it never selected.
 *
 * Mass-conservation guard (#10): when a row's stored macros are physically impossible
 * (protein+carbs+fat > 100g per 100g of food), it is never scaled to a per-serving number —
 * scaling faithfully amplifies the corruption (this is precisely how the 4,380 cal/100g Boost
 * row became a 10,512 cal "per serving" response). The row is still returned (never silently
 * dropped — a caller told the row is corrupt can act on that; one given nothing may fall back
 * to something worse), forced to `basis: "per_100g"` regardless of what weight was resolvable,
 * and flagged via `data_quality`/`macro_mass_g` so a careless caller sees the flag before the
 * number.
 */
function computeBasis(
  row: BasisInput & Partial<Record<MacroField, number | null>>
): { fields: BasisFields; scaled: Partial<Record<MacroField, number | null>> } {
  const { weight, weight_source } = resolveWeight(row.serving_weight_g, row.serving_size, row.name);

  const macroMassSum = computeMacroMassSum(row.protein ?? null, row.carbs ?? null, row.fat ?? null);
  const impossibleMacros = exceedsMassLimit(macroMassSum);

  // Corrupt rows never scale, no matter what weight would otherwise have resolved — and never
  // claim a weight_source, since we are declining to use the resolved weight, not asserting
  // none existed (keeps the existing invariant "basis per_100g => weight_source null" honest).
  const hasWeight = weight != null && !impossibleMacros;
  const effectiveWeightSource = impossibleMacros ? null : weight_source;

  const per100g: Partial<Record<MacroField, number | null>> = {};
  const scaled: Partial<Record<MacroField, number | null>> = {};

  for (const field of MACRO_FIELDS) {
    if (!(field in row)) continue;
    const stored = row[field] ?? null;
    per100g[field] = stored;
    if (stored == null) {
      scaled[field] = null;
      continue;
    }
    const headline = hasWeight ? stored * ((weight as number) / 100) : stored;
    scaled[field] = roundField(field, headline);
  }

  return {
    fields: {
      basis: hasWeight ? "per_serving" : "per_100g",
      basis_weight_g: hasWeight ? (weight as number) : null,
      weight_source: effectiveWeightSource,
      per_100g: per100g,
      data_quality: impossibleMacros ? IMPOSSIBLE_MACROS : null,
      // Unrounded deliberately: rounding could print e.g. 100.0 for a rejected 100.04 sum,
      // contradicting the strict >100 boundary to callers. Diagnostic field, not a display
      // macro — precision over prettiness.
      macro_mass_g: impossibleMacros ? macroMassSum : null,
      atwater_delta_pct: computeAtwaterDeltaPct(
        row.calories ?? null,
        row.protein ?? null,
        row.fat ?? null,
        row.carbs ?? null
      ),
      is_correction: row.is_correction === 1,
      verified_fields: parseVerifiedFields(row.verified_fields),
      superseded_by: row.superseded_by ?? null,
    },
    scaled,
  };
}

/** Build the full-detail public response for nutrition_lookup / nutrition_barcode. */
export function toFoodResponse(row: RawFoodRow): FoodResponse {
  const { fields, scaled } = computeBasis(row);
  // Destructure off the raw macro/internal columns — they're replaced by `fields`/`scaled` below.
  // Everything else in `rest` (id, name, brand, type, ean_13, source_tier, source_id,
  // source_query, serving_size, alternate_names_text, labels, ingredients, data_source,
  // cached_at, updated_at) passes through unchanged.
  const {
    calories: _calories,
    protein: _protein,
    fat: _fat,
    carbs: _carbs,
    fiber: _fiber,
    sugar: _sugar,
    sodium: _sodium,
    serving_weight_g: _servingWeightG,
    is_correction: _isCorrection,
    verified_fields: _verifiedFields,
    superseded_by: _supersededBy,
    ...rest
  } = row;

  return { ...rest, ...fields, ...scaled };
}

/** Build the lean list-item public response for nutrition_search / nutrition_cache_list. */
export function toSearchResponse(row: SearchResult): SearchResponse {
  const { fields, scaled } = computeBasis(row);
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    source_tier: row.source_tier,
    serving_size: row.serving_size,
    ...fields,
    ...scaled,
  };
}

export interface OverrideMacroInput {
  calories?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
}

export type ResolveOverrideInputResult =
  | { ok: true; converted: OverrideMacroInput; suppliedMacros: MacroField[] }
  | { ok: false; error: string };

/**
 * Validates and converts nutrition_override's per-serving/per-100g input into canonical per-100g
 * values. Extracted as a pure function (rather than living inline in the mcp.ts tool handler) so
 * the R10 rejection rule and the conversion math have a direct unit test, independent of the MCP
 * SDK's request/response plumbing.
 *
 * R10: basis "per_serving" with any macro field supplied REQUIRES serving_weight_g in the same
 * call — the stored weight is never used, since it may be exactly the value that's wrong.
 */
export function resolveOverrideInput(
  basis: "per_serving" | "per_100g",
  servingWeightG: number | undefined,
  fields: OverrideMacroInput
): ResolveOverrideInputResult {
  const suppliedMacros = MACRO_FIELDS.filter((field) => fields[field] !== undefined);

  if (basis === "per_serving" && suppliedMacros.length > 0 && servingWeightG === undefined) {
    return {
      ok: false,
      error:
        'basis "per_serving" requires serving_weight_g in this call when correcting any macro ' +
        "field. The stored serving_weight_g is never used automatically — it may be exactly the " +
        "value that's wrong.",
    };
  }

  const converted: OverrideMacroInput = { ...fields };
  if (basis === "per_serving" && servingWeightG !== undefined) {
    for (const field of suppliedMacros) {
      converted[field] = (fields[field] as number) * (100 / servingWeightG);
    }
  }

  return { ok: true, converted, suppliedMacros };
}

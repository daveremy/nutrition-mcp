/** Nutrient fields stored per-100g in the DB. Shared by FoodItem and SearchResult. */
export const MACRO_FIELDS = [
  "calories",
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sugar",
  "sodium",
] as const;
export type MacroField = (typeof MACRO_FIELDS)[number];

/**
 * Where a result's serving weight came from. "column" = the stored `serving_weight_g` value
 * (the trusted case). The other three are derived at read time by parsing `serving_size` when
 * the column is NULL — see `src/serving-parse.ts`. A derived weight must never be silently
 * indistinguishable from a stated one, so this is emitted on every response that has a weight.
 */
export type WeightSource = "column" | "parsed_grams" | "parsed_mass" | "parsed_volume";

export interface FoodItem {
  id: string;
  name: string;
  brand: string | null;
  type: "everyday" | "grocery" | "prepared" | "restaurant";
  ean_13: string | null;
  source_tier: "local" | "usda" | "web";
  source_id: string;
  source_query: string | null;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fiber: number | null;
  sugar: number | null;
  sodium: number | null;
  serving_size: string | null;
  serving_weight_g: number | null;
  alternate_names_text: string | null;
  labels: string | null;
  ingredients: string | null;
  data_source: string | null;
  /** 1 if this row was created by the correction/override path, else 0. */
  is_correction: number;
  /** JSON-stringified array of macro field names verified against a physical label, or null. */
  verified_fields: string | null;
  cached_at: string;
  updated_at: string;
}

/** A FoodItem row plus the derived (query-time) superseded_by column. */
export type RawFoodRow = FoodItem & { superseded_by: string | null };

export interface SearchResult {
  id: string;
  name: string;
  brand: string | null;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  serving_size: string | null;
  serving_weight_g: number | null;
  source_tier: string;
  is_correction: number;
  verified_fields: string | null;
  superseded_by: string | null;
}

/** Public response shape for nutrition_lookup / nutrition_barcode. */
export interface FoodResponse extends Partial<Record<MacroField, number | null>> {
  id: string;
  name: string;
  brand: string | null;
  type: FoodItem["type"];
  ean_13: string | null;
  source_tier: FoodItem["source_tier"];
  source_id: string;
  source_query: string | null;
  serving_size: string | null;
  basis: "per_serving" | "per_100g";
  basis_weight_g: number | null;
  weight_source: WeightSource | null;
  per_100g: Partial<Record<MacroField, number | null>>;
  atwater_delta_pct: number | null;
  is_correction: boolean;
  verified_fields: string[] | null;
  superseded_by: string | null;
  alternate_names_text: string | null;
  labels: string | null;
  ingredients: string | null;
  data_source: string | null;
  cached_at: string;
  updated_at: string;
}

/** Public response shape for nutrition_search / nutrition_cache_list entries. */
export interface SearchResponse extends Partial<Record<MacroField, number | null>> {
  id: string;
  name: string;
  brand: string | null;
  source_tier: string;
  serving_size: string | null;
  basis: "per_serving" | "per_100g";
  basis_weight_g: number | null;
  weight_source: WeightSource | null;
  per_100g: Partial<Record<MacroField, number | null>>;
  atwater_delta_pct: number | null;
  is_correction: boolean;
  verified_fields: string[] | null;
  superseded_by: string | null;
}

export interface CacheStats {
  total: number;
  by_tier: Record<string, number>;
  last_cached_at: string | null;
}

export interface UsdaFoodResult {
  fdcId: number;
  description: string;
  brandOwner?: string;
  gtinUpc?: string;
  foodNutrients: Array<{
    nutrientId: number;
    nutrientName: string;
    value: number;
  }>;
  servingSize?: number;
  servingSizeUnit?: string;
}

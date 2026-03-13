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
  cached_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  name: string;
  brand: string | null;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  serving_size: string | null;
  source_tier: string;
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

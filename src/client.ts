import type { FoodItem, UsdaFoodResult } from "./types.js";
import { log, normalizeBarcode } from "./utils.js";

const USDA_BASE = "https://api.nal.usda.gov/fdc/v1";

type NutrientColumn = keyof Pick<FoodItem, "calories" | "protein" | "fat" | "carbs" | "fiber" | "sugar" | "sodium">;

// USDA nutrient ID -> typed column
const NUTRIENT_MAP: Record<number, NutrientColumn> = {
  1008: "calories",
  1003: "protein",
  1004: "fat",
  1005: "carbs",
  1079: "fiber",
  2000: "sugar",
  1093: "sodium",
};

function getApiKey(): string | null {
  return process.env.USDA_API_KEY ?? null;
}

function mapUsdaToFood(item: UsdaFoodResult, query?: string): Omit<FoodItem, "cached_at" | "updated_at"> {
  const macros: Partial<Record<NutrientColumn, number | null>> = {};
  for (const n of item.foodNutrients) {
    const col = NUTRIENT_MAP[n.nutrientId];
    if (col) {
      macros[col] = n.value ?? null;
    }
  }

  const barcode = item.gtinUpc ? normalizeBarcode(item.gtinUpc) : null;

  return {
    id: `usda_${item.fdcId}`,
    name: item.description,
    brand: item.brandOwner ?? null,
    type: "everyday",
    ean_13: barcode,
    source_tier: "usda",
    source_id: String(item.fdcId),
    source_query: query ?? null,
    calories: macros.calories ?? null,
    protein: macros.protein ?? null,
    fat: macros.fat ?? null,
    carbs: macros.carbs ?? null,
    fiber: macros.fiber ?? null,
    sugar: macros.sugar ?? null,
    sodium: macros.sodium ?? null,
    serving_size: item.servingSize
      ? `${item.servingSize}${item.servingSizeUnit ?? "g"}`
      : null,
    serving_weight_g: item.servingSize ?? null,
    alternate_names_text: null,
    labels: null,
    ingredients: null,
    data_source: JSON.stringify({ source: "usda", fdcId: item.fdcId }),
  };
}

async function fetchUsdaSearch(
  query: string,
  pageSize: number,
  apiKey: string
): Promise<UsdaFoodResult[]> {
  const url = new URL(`${USDA_BASE}/foods/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());

  if (res.status === 429) {
    log("USDA API rate limited");
    return [];
  }

  if (!res.ok) {
    log(`USDA API error: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { foods: UsdaFoodResult[] };
  return data.foods ?? [];
}

export async function searchUsda(
  query: string,
  limit: number = 10
): Promise<Array<Omit<FoodItem, "cached_at" | "updated_at">>> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  try {
    const foods = await fetchUsdaSearch(query, limit, apiKey);
    return foods.map((f) => mapUsdaToFood(f, query));
  } catch (err) {
    log("USDA API network error:", err);
    return [];
  }
}

export async function lookupBarcodeUsda(
  barcode: string
): Promise<Omit<FoodItem, "cached_at" | "updated_at"> | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode) return null;

  try {
    // Clean digits, strip separators
    const cleanedBarcode = barcode.replace(/\D/g, "");

    // Try both barcode representations since USDA may index either form:
    // - 13-digit EAN starting with 0 → also try 12-digit UPC-A (strip leading 0)
    // - 12-digit UPC-A → also try 13-digit EAN (zero-pad)
    const queriesToTry = [cleanedBarcode];
    if (cleanedBarcode.length === 13 && cleanedBarcode.startsWith("0")) {
      queriesToTry.push(cleanedBarcode.slice(1));
    } else if (cleanedBarcode.length === 12) {
      queriesToTry.push("0" + cleanedBarcode);
    }

    for (const query of queriesToTry) {
      const foods = await fetchUsdaSearch(query, 25, apiKey);
      for (const item of foods) {
        if (item.gtinUpc) {
          const itemBarcode = normalizeBarcode(item.gtinUpc);
          if (itemBarcode === normalizedBarcode) {
            return mapUsdaToFood(item, barcode);
          }
        }
      }
    }

    return null;
  } catch (err) {
    log("USDA API network error:", err);
    return null;
  }
}

// Re-export for tests
export { mapUsdaToFood as _mapUsdaToFood, NUTRIENT_MAP as _NUTRIENT_MAP };

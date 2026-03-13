import type { FoodItem, SearchResult } from "./types.js";
import { NutritionStore } from "./store.js";
import { searchUsda, lookupBarcodeUsda } from "./client.js";
import { normalizeBarcode } from "./utils.js";

export class SearchOrchestrator {
  constructor(private store: NutritionStore) {}

  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    // Tier 1: local FTS search
    const localResults = this.store.search(query, limit);

    if (localResults.length >= limit) {
      return localResults;
    }

    // Collect local barcodes/IDs for dedup before caching USDA results
    const localBarcodes = new Set<string>();
    const localIds = new Set<string>();
    for (const r of localResults) {
      localIds.add(r.id);
      const full = this.store.lookup(r.id);
      if (full?.ean_13) {
        localBarcodes.add(full.ean_13);
      }
    }

    // Tier 2: USDA API fallback — over-fetch to compensate for dedup filtering
    const remaining = limit - localResults.length;
    const overFetch = Math.min(remaining + localBarcodes.size, remaining * 2, 50);
    const usdaFoods = await searchUsda(query, overFetch);

    // Dedup, cache, and collect results in one pass
    const combined = [...localResults];
    for (const food of usdaFoods) {
      // Skip USDA items that duplicate a local item by barcode
      if (food.ean_13 && localBarcodes.has(food.ean_13)) continue;
      // Skip if already in local results by ID (previously cached)
      if (localIds.has(food.id)) continue;

      // Cache non-duplicate USDA results for future searches
      this.store.upsert(food);

      combined.push({
        id: food.id,
        name: food.name,
        brand: food.brand,
        calories: food.calories,
        protein: food.protein,
        fat: food.fat,
        carbs: food.carbs,
        serving_size: food.serving_size,
        source_tier: food.source_tier,
      });
    }

    return combined.slice(0, limit);
  }

  async lookupBarcode(barcode: string): Promise<FoodItem | null> {
    const normalized = normalizeBarcode(barcode);
    if (!normalized) return null;

    // Tier 1: local lookup
    const local = this.store.lookupByBarcode(normalized);
    if (local) return local;

    // Tier 2: USDA lookup
    const usdaFood = await lookupBarcodeUsda(barcode);
    if (usdaFood) {
      this.store.upsert(usdaFood);
      return this.store.lookup(usdaFood.id);
    }

    return null;
  }
}

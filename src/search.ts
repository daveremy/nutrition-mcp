import type { FoodResponse, RawFoodRow, SearchResponse } from "./types.js";
import { NutritionStore } from "./store.js";
import { searchUsda, lookupBarcodeUsda } from "./client.js";
import { toFoodResponse, toSearchResponse, hasImpossibleMacros } from "./scaling.js";
import { normalizeBarcode } from "./utils.js";

export class SearchOrchestrator {
  constructor(private store: NutritionStore) {}

  async search(query: string, limit: number = 10): Promise<SearchResponse[]> {
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

      // Mass-conservation guard (#10): never let a physically impossible USDA row enter the
      // cache — the read-path guard in computeBasis would still catch it on every future read,
      // but not writing it at all keeps the cache itself clean and matches the issue's explicit
      // "stop it entering" requirement for the cache-write boundary. The response below is still
      // built and returned (flagged), never silently dropped.
      if (!hasImpossibleMacros(food.protein, food.carbs, food.fat)) {
        // Cache non-duplicate USDA results for future searches
        this.store.upsert(food);
      }

      // Run the freshly-fetched item through the same shared scaling helper every other read
      // path uses, rather than hand-picking raw (unscaled) fields — otherwise the *first* time a
      // USDA item is searched (before it's cached and re-read on a later search) it would ship
      // unscaled, bypassing the fix entirely for that one response (plan review round 1, P1).
      combined.push(
        toSearchResponse({
          id: food.id,
          name: food.name,
          brand: food.brand,
          calories: food.calories,
          protein: food.protein,
          fat: food.fat,
          carbs: food.carbs,
          serving_size: food.serving_size,
          serving_weight_g: food.serving_weight_g,
          source_tier: food.source_tier,
          is_correction: food.is_correction,
          verified_fields: food.verified_fields,
          // A pre-existing correction for this exact id is a narrow edge case (the id was
          // previously cached + corrected, then didn't rank in this query's top-`limit` local
          // results, so it fell through to a fresh USDA re-fetch here) — but real, so it's
          // checked explicitly rather than assumed absent.
          superseded_by: this.store.findSupersededBy(food.id),
        })
      );
    }

    return combined.slice(0, limit);
  }

  async lookupBarcode(barcode: string): Promise<FoodResponse | null> {
    const normalized = normalizeBarcode(barcode);
    if (!normalized) return null;

    // Tier 1: local lookup
    const local = this.store.lookupByBarcode(normalized);
    if (local) return local;

    // Tier 2: USDA lookup
    const usdaFood = await lookupBarcodeUsda(barcode);
    if (usdaFood) {
      // Mass-conservation guard (#10): don't cache a physically impossible USDA row — same
      // rationale as the search path above. Since it's never written, `store.lookup()` can't
      // read it back; build the flagged response directly from the in-memory USDA object
      // instead, synthesizing the fields `toFoodResponse` needs beyond `FoodItem` the same way
      // they'd look once actually stored (plan review round 1, codex).
      if (hasImpossibleMacros(usdaFood.protein, usdaFood.carbs, usdaFood.fat)) {
        const now = new Date().toISOString();
        const raw: RawFoodRow = {
          ...usdaFood,
          cached_at: now,
          updated_at: now,
          superseded_by: this.store.findSupersededBy(usdaFood.id),
        };
        return toFoodResponse(raw);
      }

      this.store.upsert(usdaFood);
      return this.store.lookup(usdaFood.id);
    }

    return null;
  }
}

---
name: nutrition
description: Look up nutrition data for foods, plan meals, calculate macros. Use when discussing calories, protein, fat, carbs, dietary analysis, food comparisons, or barcode scanning.
argument-hint: [food name, meal description, or barcode]
user_invocable: true
---

# /nutrition — Food Nutrition Lookup

Analyze nutritional content of foods using the nutrition-mcp tools.

## When the user invokes this skill

1. **Determine query type and run the lookup in a single step**:
   - All digits (12-13 chars) → `nutrition_barcode`
   - Otherwise → `nutrition_search`

2. **Check the results for seeding status**: if the response includes a seeding progress message (e.g. "Local database is being downloaded" or "X% imported"), the local database is still being populated. Show the progress to the user alongside any USDA results. If seeding hasn't started yet (no progress message and no local-tier results), call `nutrition_seed` to start it, then inform the user that the local database is being set up in the background.

3. **Check for USDA key**: if `source_tier` is only "local" for all results (no "usda" tier), append a note:
   > Note: USDA API key is not configured — results are local-only. Get a free key at https://fdc.nal.usda.gov/api-key-signup and add `USDA_API_KEY=your_key` to `.env` for broader coverage.

4. **Present results** in a table showing name, brand, and macros (calories, protein, fat, carbs) — these are scaled to the food's serving when `basis: "per_serving"`; if `basis: "per_100g"` instead, say so explicitly rather than presenting the numbers as a serving amount (the serving weight isn't known for this food). Include fiber/sugar/sodium when available. Note the source (local, USDA, or cached) and flag it if `is_correction` is true or `superseded_by` is set — see `docs/CALLER-GUIDE.md` for the full trust-signal reference.

5. **If the user wants details** on a specific result, look up the full record by ID.

6. **If results are missing, incomplete, or a poor match** (e.g. no results, only generic matches for a specific branded product, or the food is region-specific / niche):
   - Call `nutrition_cache_stats` to check seed and USDA key status.
   - If `seed.phase` is `"idle"` and local foods count is 0: call `nutrition_seed` to start seeding, then tell the user the database is being populated and to try again in a few minutes.
   - If seeding is in progress: show the progress percentage and suggest waiting.
   - If seeding is done and local data exists: **search the web** for the food's official nutrition information (manufacturer's website, product page, or a reputable nutrition database). Then cache the verified data using `nutrition_cache_add` with the source URL. This ensures the user gets accurate, up-to-date nutrition data rather than estimates.

7. **If the user says a result looks wrong** (e.g. "that can't be right", "those calories seem off", "this is the wrong product") **or reads you a physical label**:
   - If the user is reading numbers off a physical label: use `nutrition_override` with those numbers directly — `basis: "per_serving"` (the default) means you paste the label's numbers as-is with the label's `serving_weight_g`, no need to do the per-100g division yourself. `serving_weight_g` is required in the same call if you're correcting any macro field.
   - Otherwise, **web search** for the food's official nutrition information from a credible source (manufacturer label, product page, government database), then use `nutrition_override` with the corrected fields and the original food's ID (`basis: "per_100g"` if the source gives per-100g values, `basis: "per_serving"` + `serving_weight_g` if it gives per-serving values).
   - This preserves the original entry and creates/updates a corrected copy that takes precedence over the original on future lookups. Tell the user what you changed and cite the source.
   - If the cached entry is simply the wrong product (not a data error): delete it with `nutrition_cache_delete`, then search the web for the correct product and cache it with `nutrition_cache_add`.
   - If you cannot find better data, tell the user and suggest they provide the correct values manually.

8. **Browsing cached entries**: If the user wants to review what's been cached (e.g. "show me my cached foods", "what have I saved"), use `nutrition_cache_list`. Filter by `tier` ("usda", "web", or "all") as appropriate.

9. **IMPORTANT — never guess nutrition values from training data.** Nutrition information must come from one of these sources:
   - The local database or USDA API (via the nutrition tools)
   - A web search of a credible source (manufacturer label, government database, registered dietitian resource)

   If you cannot find reliable data from any of these sources, tell the user what you searched and that you couldn't find verified nutrition information. Do not fill in values from memory — they may be outdated or inaccurate.

## Examples

```
/nutrition chicken breast
/nutrition 012345678901
/nutrition compare salmon vs tilapia
```

## Notes

- Values are scaled to the food's serving when `basis: "per_serving"`; check `basis` on every
  result rather than assuming — it's `"per_100g"` (unscaled) when the serving weight isn't known
  for that food. See `docs/CALLER-GUIDE.md` for the full reference on `basis`, `atwater_delta_pct`,
  `is_correction`, `verified_fields`, and `superseded_by`.
- The local database must be seeded on first use via `nutrition_seed` (~3 min, runs in background)
- When a food isn't in the local DB or USDA, always web search for accurate data and cache it with `nutrition_cache_add` — do not rely on training data for nutrition values

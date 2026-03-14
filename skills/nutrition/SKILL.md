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

4. **Present results** in a table showing name, brand, and per-100g macros (calories, protein, fat, carbs). Include fiber/sugar/sodium when available. Note the source (local, USDA, or cached).

5. **If the user wants details** on a specific result, look up the full record by ID.

6. **If nothing is found**:
   - Call `nutrition_cache_stats` to check seed and USDA key status.
   - If `seed.phase` is `"idle"` and local foods count is 0: call `nutrition_seed` to start seeding, then tell the user the database is being populated and to try again in a few minutes.
   - If seeding is in progress: show the progress percentage and suggest waiting.
   - If seeding is done and local data exists: suggest trying alternate search terms, checking `USDA_API_KEY`, or searching the web manually and caching with `nutrition_cache_add`.

## Examples

```
/nutrition chicken breast
/nutrition 012345678901
/nutrition compare salmon vs tilapia
```

## Notes

- All values are per 100g unless a serving size is specified
- The local database must be seeded on first use via `nutrition_seed` (~3 min, runs in background)
- Tier 3 (automatic web search) is planned for a future phase

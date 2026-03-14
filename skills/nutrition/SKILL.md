---
name: nutrition
description: Look up nutrition data for foods, plan meals, calculate macros. Use when discussing calories, protein, fat, carbs, dietary analysis, food comparisons, or barcode scanning.
argument-hint: [food name, meal description, or barcode]
user_invocable: true
---

# /nutrition — Food Nutrition Lookup

Analyze nutritional content of foods using the nutrition-mcp tools.

## When the user invokes this skill

**Call the search/lookup tool immediately** — do NOT call `nutrition_cache_stats` first. Speed matters.

1. **Determine query type and run the lookup in a single step**:
   - All digits (12-13 chars) → `nutrition_barcode`
   - Otherwise → `nutrition_search`

2. **Check the results**: if `source_tier` is only "local" for all results (no "usda" tier), append a note after the table:
   > Note: USDA API key is not configured — results are local-only. Get a free key at https://fdc.nal.usda.gov/api-key-signup and add `USDA_API_KEY=your_key` to `.env` for broader coverage.

3. **Present results** in a table showing name, brand, and per-100g macros (calories, protein, fat, carbs). Include fiber/sugar/sodium when available. Note the source (local, USDA, or cached).

3. **If the user wants details** on a specific result, look up the full record by ID.

4. **If nothing is found**, suggest:
   - Trying alternate search terms
   - Checking that `USDA_API_KEY` is configured for broader coverage
   - Searching the web manually and caching the result with `nutrition_cache_add`

## Examples

```
/nutrition chicken breast
/nutrition 012345678901
/nutrition compare salmon vs tilapia
```

## Notes

- All values are per 100g unless a serving size is specified
- Tier 3 (automatic web search) is planned for a future phase

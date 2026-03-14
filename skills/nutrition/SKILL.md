---
name: nutrition
description: Look up nutrition data for foods, plan meals, calculate macros. Use when discussing calories, protein, fat, carbs, dietary analysis, food comparisons, or barcode scanning.
argument-hint: [food name, meal description, or barcode]
user_invocable: true
---

# /nutrition — Food Nutrition Lookup

Analyze nutritional content of foods using the nutrition-mcp tools.

## First-time setup

Check if `USDA_API_KEY` is set by running `nutrition_cache_stats`. If the response works but searches return few results for common branded foods, the USDA API key is likely missing. Guide the user:

1. Get a free key at https://fdc.nal.usda.gov/api-key-signup
2. Add `USDA_API_KEY=your_key` to the project's `.env` file (with direnv) or export it in their shell

The USDA API is strongly recommended — without it, only the local OpenNutrition dataset (326K foods) is searched, and many branded/packaged foods won't be found.

## When the user invokes this skill

1. **Determine query type**:
   - All digits (12-13 chars) → barcode lookup
   - Otherwise → food name search

2. **Run the appropriate lookup** and present results in a table showing name, brand, and per-100g macros (calories, protein, fat, carbs). Include fiber/sugar/sodium when available. Note the source (local, USDA, or cached).

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

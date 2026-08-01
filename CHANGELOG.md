# Changelog

## 0.4.1

- Fix: `serving_weight_g` is now derived from `serving_size` when the column is NULL
  (99.98% of NULL-weight rows carry a parseable weight, e.g. `"42GRM"`, `"8 oz"`, `"240 ml"`),
  instead of falling back to `basis: "per_100g"` and pushing the conversion onto the caller.
  Derivation is tiered by confidence: explicit grams and mass units (oz) are deterministic;
  volumetric units (ml, l, cup, tbsp, tsp, fl oz) assume water-like density (1.0 g/mL), which
  is meaningfully wrong for oils/honey/syrups — foods matching those categories by name are
  excluded from volumetric derivation entirely and fall back to the honest `per_100g` basis
  instead of a confidently wrong number (verified against a real product: Bertolli Extra
  Virgin Olive Oil). New `weight_source` field (`"column"` | `"parsed_grams"` | `"parsed_mass"`
  | `"parsed_volume"`) on every result with a resolved weight discloses which — see #5 and
  docs/CALLER-GUIDE.md. Strings that aren't confidently parseable (e.g. `"1 bottle"`, `"1
  can"`) are left as `basis: "per_100g"`, unchanged from before.
- Fix: `nutrition_search` no longer lets a `calories: null` row outrank a complete row for the
  same query — completeness (non-null calories) is now the primary sort key, with FTS
  relevance (`bm25`) as the tiebreak within each completeness bucket. See #6.

## 0.4.0

**Breaking change:** `calories`/`protein`/`fat`/`carbs`/`fiber`/`sugar`/`sodium` on
`nutrition_search`, `nutrition_lookup`, `nutrition_barcode`, and `nutrition_cache_list` results
now mean **per-serving** (scaled by `serving_weight_g`), where they previously meant per-100g
unscaled data returned under a per-serving label — see #2. The canonical per-100g values are
still available under the new `per_100g` field on every result. Check the new `basis` field
(`"per_serving"` | `"per_100g"`) rather than assuming — it is never inferred.

- Fix: macros are now scaled to the food's serving before being returned, on all four read
  surfaces (`nutrition_search`, `nutrition_lookup`, `nutrition_barcode`, `nutrition_cache_list`).
  Rows with no known serving weight (13.5% of the corpus) are returned as explicit `per_100g`
  basis rather than silently mislabeled as a serving.
- New response fields on every read surface: `basis`, `basis_weight_g`, `per_100g`,
  `atwater_delta_pct`, `is_correction`, `verified_fields`, `superseded_by`.
- `nutrition_override` now accepts `basis: "per_serving" | "per_100g"` (default `per_serving`) —
  paste numbers straight off a physical label, no need to hand-divide by serving weight.
  Corrections now reliably take precedence over the row they correct on barcode lookup, and are
  signaled (never silently missed) on search/lookup/cache-list via `is_correction`/
  `superseded_by`.
- Fix: a USDA item whose serving is reported in a non-gram unit (e.g. `"8 fl oz"`) no longer has
  that number silently treated as grams.
- New `docs/CALLER-GUIDE.md` for agents calling this server.
- Idempotent, additive-only schema migration — no data loss, no rebuild required, existing cached
  data (including hand-curated corrections) is preserved untouched.
- `package.json` gained standard OSS metadata (`repository`, `bugs`, `homepage`, `engines`).

## 0.2.0

- Auto-seed database on first run (no manual `build-db` step required)
- Store `reopen()` method for seamless post-seed reconnection
- Attribution for mcp-opennutrition inspiration and OpenNutrition dataset

## 0.1.0

- Initial release
- 7 MCP tools: nutrition_search, nutrition_lookup, nutrition_barcode, nutrition_cache_add, nutrition_cache_delete, nutrition_override, nutrition_cache_stats
- Tier 1: Local SQLite with FTS5 search (OpenNutrition dataset, 326K+ foods)
- Tier 2: USDA FoodData Central API fallback with automatic caching
- CLI: search, build-db commands
- /nutrition companion skill

# Changelog

## 0.1.0

- Initial release
- 7 MCP tools: nutrition_search, nutrition_lookup, nutrition_barcode, nutrition_cache_add, nutrition_cache_delete, nutrition_override, nutrition_cache_stats
- Tier 1: Local SQLite with FTS5 search (OpenNutrition dataset, 326K+ foods)
- Tier 2: USDA FoodData Central API fallback with automatic caching
- CLI: search, build-db commands
- /nutrition companion skill

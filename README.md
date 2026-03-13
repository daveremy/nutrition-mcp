# nutrition-mcp

A 3-tier nutrition lookup MCP server with local SQLite caching. Searches 326K+ foods locally, falls back to the USDA FoodData Central API, and caches results for instant future lookups.

## Setup

```bash
npm install
npm run build
```

### Database

The database is automatically seeded on first run — no manual step required. The first startup downloads and imports the OpenNutrition dataset (~326K foods), which takes a few minutes. Subsequent starts are instant.

The database is stored at `~/.nutrition-mcp/nutrition.db`.

To manually rebuild (e.g. after a dataset update):

```bash
npx nutrition-mcp build-db
```

Rebuilding preserves any previously cached USDA and web results.

### USDA API key (optional)

For tier 2 fallback searches, set a free [USDA FoodData Central](https://fdc.nal.usda.gov/api-key-signup) API key:

```bash
export USDA_API_KEY=your_key_here
```

Without this, only the local database is searched.

## MCP Server

### With Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "nutrition-mcp": {
      "command": "npx",
      "args": ["-y", "nutrition-mcp"]
    }
  }
}
```

Or for local development:

```json
{
  "mcpServers": {
    "nutrition-mcp": {
      "command": "node",
      "args": ["--import", "tsx", "src/mcp.ts"],
      "env": {
        "USDA_API_KEY": "your_key_here"
      }
    }
  }
}
```

### Tools

#### `nutrition_search`

Search foods by name. Returns matching foods with macros.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | required | Food name to search for |
| `limit` | number | 10 | Max results (1-50) |

Returns an array of `{ id, name, brand, calories, protein, fat, carbs, serving_size, source_tier }`.

#### `nutrition_lookup`

Look up a specific food by ID. Returns the complete food record with all nutrition fields.

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | Food ID (e.g. `on_abc123`, `usda_12345`) |

#### `nutrition_barcode`

Look up a food by barcode. Accepts 12-digit UPC-A or 13-digit EAN-13. Searches locally first, then USDA.

| Param | Type | Description |
|-------|------|-------------|
| `barcode` | string | 12 or 13 digit barcode |

#### `nutrition_cache_add`

Add or update a food item in the local cache. Useful for saving nutrition data found on the web.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Food name |
| `calories` | number | yes | kcal per 100g |
| `protein` | number | yes | grams per 100g |
| `fat` | number | yes | grams per 100g |
| `carbs` | number | yes | grams per 100g |
| `source_url` | string | yes | Source URL (stable dedup key) |
| `brand` | string | no | Brand name |
| `fiber` | number | no | grams per 100g |
| `sugar` | number | no | grams per 100g |
| `sodium` | number | no | mg per 100g |
| `serving_size` | string | no | e.g. "1 cup (240g)" |
| `serving_weight_g` | number | no | Serving weight in grams |
| `ean_13` | string | no | EAN-13 barcode |

#### `nutrition_cache_delete`

Delete a cached food entry by ID. Refuses to delete local dataset entries (`on_` prefix) — use `build-db` to manage those.

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | Food ID to delete (e.g. `usda_12345`, `web_abc123`) |

#### `nutrition_override`

Override nutrition data for an existing food. Creates a corrected web-tier copy that inherits all fields from the original, with your corrections applied. Useful when USDA or local data is inaccurate. Repeated overrides of the same food update the existing override entry.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | ID of the food to override |
| `name` | string | no | Corrected name |
| `brand` | string | no | Corrected brand |
| `calories` | number | no | Corrected calories per 100g |
| `protein` | number | no | Corrected protein g per 100g |
| `fat` | number | no | Corrected fat g per 100g |
| `carbs` | number | no | Corrected carbs g per 100g |
| `fiber` | number | no | Corrected fiber g per 100g |
| `sugar` | number | no | Corrected sugar g per 100g |
| `sodium` | number | no | Corrected sodium mg per 100g |
| `serving_size` | string | no | Corrected serving size |
| `serving_weight_g` | number | no | Corrected serving weight |

#### `nutrition_cache_stats`

Returns cache statistics: total foods, count by source tier, and last cached timestamp. No parameters.

## CLI

```bash
# Search for foods
nutrition-mcp search "chicken breast"
nutrition-mcp search "protein bar" --limit 20

# Rebuild the database
nutrition-mcp build-db

# Start MCP server (default, used by Claude Code)
nutrition-mcp
```

## Companion skill

The `/nutrition` skill (in `skills/nutrition/SKILL.md`) lets Claude Code users type `/nutrition chicken breast` to get a formatted nutrition table. Install by copying the skill to your project or personal skills directory:

```bash
# Project-scoped
cp -r skills/nutrition .claude/skills/

# Personal (available in all projects)
cp -r skills/nutrition ~/.claude/skills/
```

## How it works

### 3-tier search

1. **Tier 1 (local)** — FTS5 full-text search against the local SQLite database (326K+ foods from OpenNutrition)
2. **Tier 2 (USDA)** — If local results are insufficient, queries the USDA FoodData Central API. Results are cached locally.
3. **Tier 3 (web)** — Coming in a future phase. For now, use `nutrition_cache_add` to manually save web-sourced data.

### Data

All nutrition values are per 100g. Core macros: calories (kcal), protein (g), fat (g), carbs (g), fiber (g), sugar (g), sodium (mg).

Foods are identified by prefixed IDs: `on_` (OpenNutrition), `usda_` (USDA), `web_` (manually cached).

## Development

```bash
npm run dev          # Start MCP server with tsx
npm test             # Run tests (node:test + tsx)
npm run build        # Compile TypeScript
npm run seed         # Seed/rebuild database
```

## Acknowledgments

Inspired by [mcp-opennutrition](https://github.com/deadletterq/mcp-opennutrition) by deadletterq. This project uses the [OpenNutrition dataset](https://www.opennutrition.app/) which combines data from USDA, CNF, FRIDA, and AUSNUT sources, licensed under ODbL 1.0.

## License

MIT

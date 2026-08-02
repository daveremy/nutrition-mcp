# nutrition-mcp

A 3-tier nutrition lookup MCP server with local SQLite caching. Searches 326K+ foods locally, falls back to the USDA FoodData Central API, and caches results for instant future lookups.

## Setup

```bash
npm install
npm run build
```

### Database

The local database is seeded on first use via the `nutrition_seed` tool (triggered automatically by the companion skill). The first seed downloads and imports the OpenNutrition dataset (~326K foods), which takes a few minutes in the background. Tools work immediately — USDA API results are available while seeding runs.

The database is stored at `~/.nutrition-mcp/nutrition.db`.

To manually rebuild (e.g. after a dataset update):

```bash
npx nutrition-mcp build-db
```

Rebuilding preserves any previously cached USDA and web results.

### USDA API Key (recommended)

A free [USDA FoodData Central](https://fdc.nal.usda.gov/api-key-signup) API key is strongly recommended. Without it, searches are limited to the local OpenNutrition dataset and many branded/packaged foods won't be found.

```bash
export USDA_API_KEY=your_key_here
```

With [direnv](https://direnv.net/), add it to your project's `.env` file so it's automatically available.

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

Returns an array of results, each shaped like:

```jsonc
{
  "id": "on_fd_vUZSKMYWbRkt", "name": "G2G Coconut Almond Protein Bar", "brand": "G2G",
  "source_tier": "local", "serving_size": "1 bar",
  "calories": 300, "protein": 18.0, "fat": 12.0, "carbs": 22.0,   // scaled to the serving
  "basis": "per_serving", "basis_weight_g": 70,                   // never inferred — always check this
  "weight_source": "column",                                     // "column" | "parsed_grams" | "parsed_mass" | "parsed_volume"
  "per_100g": { "calories": 429, "protein": 25.7, "fat": 17.1, "carbs": 31.4 },
  "atwater_delta_pct": 0.2, "is_correction": false,
  "verified_fields": null, "superseded_by": null,
  "data_quality": null, "macro_mass_g": null
}
```

If `serving_weight_g` isn't stored for a food, the server tries to derive it by parsing
`serving_size` (e.g. `"42GRM"` -> 42g, `"8 oz"` -> 226.8g, `"1 cup"` -> 240g assuming
water-like density) before falling back to `per_100g`. `weight_source` tells you which:
`"column"` (stated) and `"parsed_grams"`/`"parsed_mass"` (deterministic) are as trustworthy as
a stated weight; `"parsed_volume"` assumes 1.0 g/mL density, so treat it more cautiously — and
note that foods matching an oil/honey/syrup-class name never get a `parsed_volume` weight at
all (a 1.0 g/mL guess is wrong enough there that they fall back to `per_100g` instead) — see
[docs/CALLER-GUIDE.md](docs/CALLER-GUIDE.md). Only when no weight can be resolved at all (e.g.
`serving_size: "1 bottle"`, or an oil/honey-class food with only a volumetric serving size)
does `basis` fall back to `"per_100g"`, with the headline values being the canonical per-100g
numbers — never silently mislabeled as a serving. `per_100g` is
always present regardless of basis. See docs/CALLER-GUIDE.md for how to use `basis`,
`weight_source`, `atwater_delta_pct`, `is_correction`, and `superseded_by`.

Every result is also checked for **mass conservation**: if `protein + carbs + fat` (per 100g)
exceeds 100g, the row is physically impossible and `data_quality` is `"impossible_macros"` —
in that case `calories`/`protein`/`fat`/`carbs`/`fiber`/`sugar`/`sodium` are all returned
`null` (never a corrupt or scaled-up number) and `macro_mass_g` reports the impossible sum;
`per_100g` still carries the raw stored values for reference. See docs/CALLER-GUIDE.md.

#### `nutrition_lookup`

Look up a specific food by ID. Returns the complete food record, shaped like the `nutrition_search`
result above (see there for the `basis`/`per_100g`/trust-signal fields) plus full source metadata
(`type`, `ean_13`, `source_id`, `source_query`, `alternate_names_text`, `labels`, `ingredients`,
`data_source`, `cached_at`, `updated_at`). If `superseded_by` is non-null, a correction exists for
this exact id — look that id up instead.

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | Food ID (e.g. `on_abc123`, `usda_12345`) |

#### `nutrition_barcode`

Look up a food by barcode. Accepts 12-digit UPC-A or 13-digit EAN-13. Searches locally first, then
USDA. Same response shape as `nutrition_lookup`. If a correction exists for this barcode, returns
the correction, not the original.

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

#### `nutrition_cache_list`

List cached food entries (USDA and web-sourced). Does not include the local OpenNutrition dataset.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `tier` | string | `all` | Filter: `usda`, `web`, or `all` |
| `limit` | number | 20 | Page size (1-100) |
| `offset` | number | 0 | Pagination offset |

Returns entries in the same shape as `nutrition_search`, ordered by most recently updated —
except a correction (`is_correction: true`) always sorts ahead of the row it corrects.

#### `nutrition_cache_delete`

Delete a cached food entry by ID. Refuses to delete local dataset entries (`on_` prefix) — use `build-db` to manage those.

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | Food ID to delete (e.g. `usda_12345`, `web_abc123`) |

#### `nutrition_override`

Correct nutrition data for an existing food — e.g. from a physical label. Creates a corrected
web-tier copy that inherits all fields from the original, with your corrections applied. Repeated
corrections of the same food update the existing entry (not a new one each time). A correction
takes precedence over the original on barcode lookup, and is signaled via `is_correction`/
`superseded_by` on search/lookup/cache-list.

Defaults to `basis: "per_serving"` — paste the numbers straight off a physical label, no need to
divide by hand. `serving_weight_g` is **required in the same call** whenever you supply any macro
field under `basis: "per_serving"` — the stored weight is never used automatically, since it may
be exactly what's wrong.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | ID of the food to correct |
| `name` | string | no | Corrected name |
| `brand` | string | no | Corrected brand |
| `basis` | `"per_serving"` \| `"per_100g"` | no (default `per_serving`) | Whether the macro fields below are per-serving (the label case) or per-100g |
| `calories` | number | no | Corrected calories, per `basis` |
| `protein` | number | no | Corrected protein g, per `basis` |
| `fat` | number | no | Corrected fat g, per `basis` |
| `carbs` | number | no | Corrected carbs g, per `basis` |
| `fiber` | number | no | Corrected fiber g, per `basis` |
| `sugar` | number | no | Corrected sugar g, per `basis` |
| `sodium` | number | no | Corrected sodium mg, per `basis` |
| `serving_size` | string | no | Corrected serving size description |
| `serving_weight_g` | number (>0) | required with `basis: "per_serving"` + any macro field | Corrected serving weight in grams |

#### `nutrition_seed`

Seed the local database with 326K+ foods in the background. Returns immediately — call again to check progress. Idempotent: no-op if already seeded, returns progress if in progress. No parameters.

#### `nutrition_cache_stats`

Returns cache statistics: total foods, count by source tier, last cached timestamp, and seed status (phase, progress percentage). No parameters.

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

For a detailed technical overview, see [docs/architecture.md](docs/architecture.md). For guidance
on interpreting responses as a calling agent (trusting `basis`, `weight_source`,
`atwater_delta_pct`, `is_correction`; when to verify vs. ask the user; how to correct from a
physical label), see [docs/CALLER-GUIDE.md](docs/CALLER-GUIDE.md).

### 3-tier search

1. **Tier 1 (local)** — FTS5 full-text search against the local SQLite database (326K+ foods from OpenNutrition)
2. **Tier 2 (USDA)** — If local results are insufficient, queries the USDA FoodData Central API. Results are cached locally.
3. **Tier 3 (web)** — Coming in a future phase. For now, use `nutrition_cache_add` to manually save web-sourced data.

### Data

Nutrition values are **stored** per 100g internally. What a tool call **returns** is scaled to the
food's serving whenever a weight is known or can be derived from `serving_size` — check the
`basis` field on every result rather than assuming (see the `nutrition_search`/`nutrition_lookup`
sections above, and
[docs/CALLER-GUIDE.md](docs/CALLER-GUIDE.md) for a full walkthrough for callers). Core macros:
calories (kcal), protein (g), fat (g), carbs (g), fiber (g), sugar (g), sodium (mg).

Foods are identified by prefixed IDs: `on_` (OpenNutrition), `usda_` (USDA), `web_` (manually
cached or corrected via `nutrition_override`).

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

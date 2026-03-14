# Architecture

## Overview

nutrition-mcp is a Model Context Protocol (MCP) server that resolves food items to nutrition data using a 3-tier search strategy. It runs as a stdio-based MCP server, typically launched by Claude Code via `npx`.

```
┌─────────────┐     stdio      ┌──────────────────────────────────┐
│ Claude Code │◄──────────────►│         MCP Server (mcp.ts)       │
└─────────────┘    JSON-RPC    │                                   │
                               │  ┌─────────────────────────────┐  │
                               │  │  Search Orchestrator        │  │
                               │  │  (search.ts)                │  │
                               │  │                             │  │
                               │  │  Tier 1: Local FTS5 search  │  │
                               │  │  Tier 2: USDA API fallback  │  │
                               │  │  Tier 3: Web (future)       │  │
                               │  └──────┬──────────┬───────────┘  │
                               │         │          │              │
                               │  ┌──────▼───┐  ┌──▼───────────┐  │
                               │  │  Store    │  │ USDA Client  │  │
                               │  │(store.ts) │  │ (client.ts)  │  │
                               │  └──────┬───┘  └──────────────┘  │
                               │         │                         │
                               │  ┌──────▼──────────────────────┐  │
                               │  │  SQLite (better-sqlite3)    │  │
                               │  │  ~/.nutrition-mcp/          │  │
                               │  │  nutrition.db               │  │
                               │  └─────────────────────────────┘  │
                               └───────────────────────────────────┘
```

## Module Responsibilities

| Module | Role |
|--------|------|
| `mcp.ts` | MCP server setup, tool definitions, stdio transport |
| `search.ts` | Search orchestration — tier blending, cross-tier dedup, cache-on-read |
| `store.ts` | SQLite layer — schema, FTS5 search, CRUD, upsert, bulk insert |
| `client.ts` | USDA FoodData Central API client — search, barcode lookup, nutrient mapping |
| `seed.ts` | Dataset download, extraction, bulk import, FTS index build |
| `seed-state.ts` | Shared seed progress state (phase, inserted count, errors) |
| `cli.ts` | CLI entry point — `search` and `build-db` commands |
| `utils.ts` | Shared helpers — DB path, barcode normalization, logging |

## Startup and Seeding

Claude Code imposes a ~30-second timeout on MCP server startup. The OpenNutrition dataset (~60MB download, 326K foods) takes several minutes to download and import. The server handles this with **explicit, tool-triggered seeding**:

1. **Startup is instant** — `startServer()` only connects the stdio transport. No seeding, no data checks. The MCP handshake completes within seconds.
2. **Seeding is triggered via `nutrition_seed` tool** — the companion skill (`SKILL.md`) detects an empty database (via `nutrition_cache_stats`) and calls `nutrition_seed`. The tool returns immediately; seeding runs in the background.
3. **Progress is tracked in-memory** — `seed-state.ts` exposes a shared `SeedState` object with phase (`downloading` → `extracting` → `importing` → `indexing` → `done`), inserted count, and estimated total. Both `nutrition_seed` (for polling) and `nutrition_search` (for inline messages) read this state.
4. **Tools work during seeding** — USDA API searches work if `USDA_API_KEY` is set. Search results include a progress message (e.g. "42% imported") when seeding is active.
5. **Idempotent** — calling `nutrition_seed` when already seeding returns progress; when already seeded returns "already seeded"; after a failure allows retry.

```
Timeline:
  0s   ─── server.connect() ─── MCP handshake complete ─── tools available
       ─── skill calls nutrition_seed ─── returns immediately
       ─── background: download → extract → import → FTS index
  ~3m  ─── seed complete ─── store.reopen() ─── local search available
```

### Why not auto-seed on startup?

Earlier versions auto-seeded in `startServer()`. This was removed because:
- Implicit background work creates surprising behavior — sparse results with no explanation
- The skill can detect the empty database and trigger seeding explicitly, giving the user clear feedback
- The `nutrition_seed` tool is idempotent and reports progress, making the experience transparent

### Why not bundle the dataset?

Some MCP servers (e.g. mcp-opennutrition) bundle the 60MB dataset in the npm package and build the DB at install time. We download at runtime instead because:

- The npm package stays small (22KB vs 60MB+)
- `npx -y nutrition-mcp` installs near-instantly
- The tradeoff is a slower first run, which the explicit seed tool handles transparently

## Database

### Storage

The database lives at `~/.nutrition-mcp/nutrition.db` (SQLite, WAL mode). This path is outside the project directory so it persists across `npx` invocations and project contexts.

### Schema

Single `foods` table with typed macro columns (not JSON blobs) for the 7 core nutrients: calories, protein, fat, carbs, fiber, sugar, sodium. All values are per 100g.

Key constraints:
- `UNIQUE(source_tier, source_id)` — prevents duplicate entries from repeated USDA searches
- `idx_foods_ean13` — partial index on barcodes for fast barcode lookups

### Full-Text Search

FTS5 virtual table (`foods_fts`) indexes `name`, `brand`, and `alternate_names_text`. Sync triggers keep the index updated on every insert/update/delete.

During seeding, triggers are omitted for performance — FTS is created after all data (including preserved cached entries) is imported, then rebuilt in one pass.

### ID Scheme

Foods are identified by prefixed IDs that encode their source:
- `on_*` — OpenNutrition dataset (local, immutable)
- `usda_*` — USDA FoodData Central API (cached on first lookup)
- `web_*` — manually cached via `nutrition_cache_add`

## Search Strategy

The search orchestrator (`search.ts`) implements tier blending:

1. **Tier 1 (local)** — FTS5 prefix search against SQLite. Input is sanitized (FTS operators stripped). Results ranked by BM25.
2. **Tier 2 (USDA)** — if tier 1 returns fewer than `limit` results and `USDA_API_KEY` is set, queries the USDA API for remaining slots. Results are cached locally via upsert (`ON CONFLICT DO UPDATE`) so future searches hit tier 1.
3. **Cross-tier dedup** — only by exact `ean_13` match (both items must have a barcode). No name-based dedup — different items legitimately share names. Tier 1 is preferred when deduplicating.

### Barcode Lookup

Barcodes are normalized to 13-digit EAN-13 (12-digit UPC-A is zero-padded). Local lookup is by `ean_13` index. USDA fallback searches both the original and normalized forms since USDA may index either.

## Logging

All logging goes to stderr via `log()` from `utils.ts`, prefixed with `[nutrition-mcp]`. This is critical because stdout is the MCP JSON-RPC transport — any non-JSON output on stdout breaks the protocol. Stderr output appears in Claude Code's MCP debug logs (`claude mcp logs`).

## Release Process

Automated via `scripts/release.sh`:

1. Verify clean main branch
2. Run tests
3. Bump version in package.json, version.ts, plugin.json
4. Build and verify package contents
5. Commit and tag
6. **Publish to npm before pushing** — if publish fails, no tag/commit escapes to remote
7. Push to GitHub (commit + specific tag only)
8. Update aggregated marketplace (`daveremy/claude-plugins`)

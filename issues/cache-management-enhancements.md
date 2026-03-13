# Cache management enhancements

## Context

Phase 1 ships with basic cache management (`nutrition_cache_delete`, `nutrition_override`, `nutrition_cache_add`). Several useful capabilities are deferred to keep scope tight.

## Proposed additions

### `nutrition_cache_list` — browse cached entries

Paginated listing of cached USDA and web entries. Helps users see what's been cached without searching for specific items.

**Params:**
- `tier` (optional): filter by `usda`, `web`, or `all` (default: `all`)
- `offset` (optional, default 0): pagination offset
- `limit` (optional, default 20): page size

**Returns:** array of `{ id, name, brand, source_tier, cached_at, updated_at }`

**Why:** Users currently have no way to see what's in the cache without knowing exact food names. This is especially useful after bulk USDA searches to review what was auto-cached.

### Cache TTL / staleness detection

Add an `updated_at`-based staleness check. USDA data can change (reformulations, corrections). Options:

1. **Passive:** `nutrition_lookup` and `nutrition_search` include an `is_stale` flag on results older than N days (configurable, default 90)
2. **Active:** `nutrition_cache_refresh` tool re-fetches stale USDA entries from the API and updates them in place
3. **Bulk:** `nutrition_cache_cleanup` removes entries older than a threshold, or all entries from a given tier

Recommend starting with option 1 (passive flag) since it's non-destructive and gives users the information to decide.

### Bulk import/export of overrides

Allow users to export their overrides as JSON and import them on another machine or after a `build-db` rebuild.

- `nutrition_cache_export` → JSON array of all `web`-tier entries
- `nutrition_cache_import` → accepts JSON array, upserts each entry

**Why:** Overrides are user-created corrections. They survive `build-db` today (the seed script preserves `usda`/`web` rows), but having an explicit export provides a safety net and enables sharing corrections across machines.

## Priority

- `nutrition_cache_list`: high (simple, high utility)
- Cache TTL/staleness: medium (useful but not blocking)
- Bulk import/export: low (nice-to-have for power users)

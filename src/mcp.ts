#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { NutritionStore } from "./store.js";
import { SearchOrchestrator } from "./search.js";
import { resolveOverrideInput } from "./scaling.js";
import { getSeedState, isSeeding, seedPercent, seedProgressMessage, setSeedError, setSeedPhase, startSeed } from "./seed-state.js";
import { log, normalizeBarcode } from "./utils.js";
import { VERSION } from "./version.js";

const store = new NutritionStore();
const orchestrator = new SearchOrchestrator(store);

/** Auto-trigger seeding if DB is empty and no seed is running/done. */
function ensureSeeded(): void {
  const { phase } = getSeedState();
  if (phase !== "idle" && phase !== "failed") return; // already in progress or done
  if (store.getStats().by_tier.local) return; // already has local data
  setSeedPhase("downloading"); // mark active immediately so isSeeding() is true before async work starts
  startSeed(() =>
    import("./seed.js")
      .then(({ seedDatabase }) => seedDatabase())
      .then(() => {
        store.reopen();
        log("Database seeded successfully. Local search is now available.");
      })
      .catch((err) => {
        setSeedError(err);
        log("Seed failed:", err);
      })
  );
}

const server = new McpServer({
  name: "nutrition-mcp",
  version: VERSION,
});

server.tool(
  "nutrition_search",
  "Search for foods by name. Returns matching foods with macros (calories, protein, fat, carbs) scaled to the food's serving — check the `basis` field (\"per_serving\" vs \"per_100g\") on every result, it is never implied. `weight_source` (\"column\" | \"parsed_grams\" | \"parsed_mass\" | \"parsed_volume\") tells you whether the serving weight was stated or derived; `parsed_volume` assumes water-like density, so treat it more cautiously than the other three (oils/honey/syrup are excluded from it entirely and stay `per_100g` instead). `per_100g` on each result carries the canonical values regardless of basis. If `data_quality` is \"impossible_macros\" (protein+carbs+fat exceed 100g per 100g of food — physically impossible), the row is corrupt: never log its values, `macro_mass_g` shows the impossible sum, web-search or ask the user instead. `is_correction`/`superseded_by`/`verified_fields` signal trust; see docs/CALLER-GUIDE.md. Searches local database first, then USDA API.",
  {
    query: z.string().describe("Food name to search for"),
    limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
  },
  async ({ query, limit }) => {
    ensureSeeded();
    const results = await orchestrator.search(query, limit);
    const content: Array<{ type: "text"; text: string }> = [
      { type: "text" as const, text: JSON.stringify(results, null, 2) },
    ];
    if (isSeeding()) {
      content.push({ type: "text" as const, text: seedProgressMessage() });
    }
    return { content };
  }
);

server.tool(
  "nutrition_lookup",
  "Look up a specific food by ID. Returns complete nutrition data scaled to the serving (check `basis`/`basis_weight_g`/`weight_source`; `per_100g` always has the canonical values too). If `data_quality` is \"impossible_macros\" (protein+carbs+fat exceed 100g per 100g of food), the row is corrupt — never log its values, web-search or ask the user instead. If `superseded_by` is non-null, a correction exists for this exact id and its id should be looked up instead. See docs/CALLER-GUIDE.md for how to use these signals.",
  {
    id: z.string().describe("Food ID (e.g. on_abc123, usda_12345)"),
  },
  async ({ id }) => {
    const food = store.lookup(id);
    if (!food) {
      return {
        content: [{ type: "text" as const, text: "Food not found" }],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(food, null, 2) },
      ],
    };
  }
);

server.tool(
  "nutrition_barcode",
  "Look up a food by barcode (UPC-A 12-digit or EAN-13). Returns data scaled to the serving (check `basis`/`basis_weight_g`/`weight_source`; `per_100g` always has the canonical values too) and, if a correction exists for this barcode, returns the correction rather than the original. If `data_quality` is \"impossible_macros\", the row is corrupt — never log its values, web-search or ask the user instead. Searches local database first, then USDA API.",
  {
    barcode: z.string().describe("Barcode (12 or 13 digits)"),
  },
  async ({ barcode }) => {
    ensureSeeded();
    const food = await orchestrator.lookupBarcode(barcode);
    const content: Array<{ type: "text"; text: string }> = [];
    if (!food) {
      content.push({ type: "text" as const, text: "Food not found for this barcode" });
    } else {
      content.push({ type: "text" as const, text: JSON.stringify(food, null, 2) });
    }
    if (isSeeding()) {
      content.push({ type: "text" as const, text: seedProgressMessage() });
    }
    return { content, ...(!food ? { isError: true } : {}) };
  }
);

server.tool(
  "nutrition_cache_add",
  "Add or update a food item in the local cache. Use this to save nutrition data from web searches or manual entry.",
  {
    name: z.string().describe("Food name"),
    brand: z.string().optional().describe("Brand name"),
    calories: z.number().describe("Calories per 100g"),
    protein: z.number().describe("Protein grams per 100g"),
    fat: z.number().describe("Fat grams per 100g"),
    carbs: z.number().describe("Carbs grams per 100g"),
    fiber: z.number().optional().describe("Fiber grams per 100g"),
    sugar: z.number().optional().describe("Sugar grams per 100g"),
    sodium: z.number().optional().describe("Sodium mg per 100g"),
    serving_size: z.string().optional().describe("Serving size description"),
    serving_weight_g: z.number().optional().describe("Serving weight in grams"),
    source_url: z.string().describe("Source URL (used as stable dedup key)"),
    ean_13: z.string().optional().describe("EAN-13 barcode"),
  },
  async ({ name, brand, calories, protein, fat, carbs, fiber, sugar, sodium, serving_size, serving_weight_g, source_url, ean_13 }) => {
    const id = NutritionStore.generateId("web");
    const normalizedBarcode = ean_13 ? normalizeBarcode(ean_13) : null;

    store.upsert({
      id,
      name,
      brand: brand ?? null,
      type: "everyday",
      ean_13: normalizedBarcode,
      source_tier: "web",
      source_id: source_url,
      source_query: null,
      calories,
      protein,
      fat,
      carbs,
      fiber: fiber ?? null,
      sugar: sugar ?? null,
      sodium: sodium ?? null,
      serving_size: serving_size ?? null,
      serving_weight_g: serving_weight_g ?? null,
      alternate_names_text: null,
      labels: null,
      ingredients: null,
      data_source: JSON.stringify({ source: "web", url: source_url }),
      is_correction: 0,
      verified_fields: null,
    });

    return {
      content: [
        { type: "text" as const, text: `Cached "${name}" successfully` },
      ],
    };
  }
);

server.tool(
  "nutrition_cache_delete",
  "Delete a cached food entry by ID. Cannot delete local dataset entries (on_ prefix) — use build-db to rebuild those.",
  {
    id: z.string().describe("Food ID to delete (e.g. usda_12345, web_abc123)"),
  },
  async ({ id }) => {
    const result = store.delete(id);
    if (!result.deleted) {
      return {
        content: [{ type: "text" as const, text: result.reason ?? "Food not found" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Deleted ${id}` }],
    };
  }
);

server.tool(
  "nutrition_override",
  "Correct nutrition data for an existing food entry, e.g. from a physical label. Creates a corrected copy as a web-tier entry, preserving the original; repeated corrections of the same food update that entry. Defaults to per-serving input (basis: \"per_serving\") since that's what a physical label shows — pass the label's serving_weight_g and the label's numbers as-is, no need to divide by hand. Use basis: \"per_100g\" only if you already have per-100g values.",
  {
    id: z.string().describe("ID of the food to correct"),
    name: z.string().optional().describe("Corrected name"),
    brand: z.string().optional().describe("Corrected brand"),
    basis: z
      .enum(["per_serving", "per_100g"])
      .default("per_serving")
      .describe(
        "Whether calories/protein/fat/carbs/fiber/sugar/sodium below are per-serving (the label case — requires serving_weight_g) or already per-100g."
      ),
    calories: z.number().optional().describe("Corrected calories, per basis"),
    protein: z.number().optional().describe("Corrected protein g, per basis"),
    fat: z.number().optional().describe("Corrected fat g, per basis"),
    carbs: z.number().optional().describe("Corrected carbs g, per basis"),
    fiber: z.number().optional().describe("Corrected fiber g, per basis"),
    sugar: z.number().optional().describe("Corrected sugar g, per basis"),
    sodium: z.number().optional().describe("Corrected sodium mg, per basis"),
    serving_size: z.string().optional().describe("Corrected serving size description"),
    serving_weight_g: z
      .number()
      .positive()
      .optional()
      .describe(
        "Corrected serving weight in grams. REQUIRED when basis is \"per_serving\" and any macro field is supplied — never inherited from the existing row, since the stored weight may be exactly what's wrong."
      ),
  },
  async ({ id, basis, serving_weight_g, ...fields }) => {
    const resolved = resolveOverrideInput(basis, serving_weight_g, fields);
    if (!resolved.ok) {
      return {
        content: [{ type: "text" as const, text: resolved.error }],
        isError: true,
      };
    }

    const result = store.override(id, {
      name: fields.name,
      brand: fields.brand,
      serving_size: fields.serving_size,
      ...resolved.converted,
      ...(serving_weight_g !== undefined ? { serving_weight_g } : {}),
    });
    if (!result.overridden) {
      return {
        content: [{ type: "text" as const, text: result.reason ?? "Override failed" }],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text" as const, text: `Created/updated correction ${result.override_id} for ${id}` },
      ],
    };
  }
);

server.tool(
  "nutrition_seed",
  "Seed the local database with 326K+ foods (~60MB download, takes a few minutes). Returns immediately — seeding runs in the background. Call again to check progress. Idempotent: no-op if already seeded.",
  {},
  async () => {
    const seedState = getSeedState();

    // Already seeded
    if (seedState.phase === "done" || store.getStats().by_tier.local) {
      return {
        content: [{ type: "text" as const, text: "Local database is already seeded." }],
      };
    }

    // Already in progress
    if (isSeeding()) {
      return {
        content: [{ type: "text" as const, text: seedProgressMessage() }],
      };
    }

    // Start or retry seeding
    if (seedState.phase === "failed") {
      log(`Previous seed failed (${seedState.error}), retrying...`);
    }
    ensureSeeded();

    return {
      content: [{ type: "text" as const, text: "Seeding started. This will take a few minutes. You can continue searching — USDA API results are available immediately. Call this tool again to check progress." }],
    };
  }
);

server.tool(
  "nutrition_cache_list",
  "List cached food entries (USDA and web-sourced). Shows what has been cached from API lookups, web searches, and manual additions. Values are scaled per `basis` like other read tools; corrections (`is_correction: true`) are listed ahead of the rows they correct. A row with `data_quality: \"impossible_macros\"` is corrupt (protein+carbs+fat exceed 100g per 100g) and should never be logged as-is. Does not include the local OpenNutrition dataset.",
  {
    tier: z.enum(["usda", "web", "all"]).default("all").describe("Filter by source tier"),
    limit: z.number().min(1).max(100).default(20).describe("Page size"),
    offset: z.number().min(0).default(0).describe("Pagination offset"),
  },
  async ({ tier, limit, offset }) => {
    const results = store.listCached(tier, limit, offset);
    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No cached entries found." }],
      };
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(results, null, 2) },
      ],
    };
  }
);

server.tool(
  "nutrition_cache_stats",
  "Get statistics about the local nutrition cache: total foods, breakdown by source tier, last cached timestamp, and seed status.",
  {},
  async () => {
    const stats = store.getStats();
    const { phase, inserted, totalEstimate, error } = getSeedState();
    const result = {
      ...stats,
      usda_api_configured: !!process.env.USDA_API_KEY,
      seed: {
        phase,
        ...(isSeeding() ? {
          inserted,
          total_estimate: totalEstimate,
          percent: seedPercent(),
          message: seedProgressMessage(),
        } : {}),
        ...(phase === "failed" ? { error } : {}),
      },
    };
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }
);

export async function startServer(): Promise<void> {
  if (!process.env.USDA_API_KEY) {
    log("Warning: USDA_API_KEY not set. Only local database will be searched.");
    log("Get a free key at https://fdc.nal.usda.gov/api-key-signup");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start only when run directly (not imported by CLI)
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}

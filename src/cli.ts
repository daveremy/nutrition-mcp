#!/usr/bin/env node
import { Command } from "commander";

import { NutritionStore } from "./store.js";
import { SearchOrchestrator } from "./search.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("nutrition-mcp")
  .description("Nutrition lookup MCP server with local SQLite caching")
  .version(VERSION);

program
  .command("search <query>")
  .description("Search for foods and print results")
  .option("-l, --limit <n>", "Max results", "10")
  .action(async (query: string, opts: { limit: string }) => {
    const limit = parseInt(opts.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("Error: --limit must be a positive integer");
      process.exit(1);
    }
    const store = new NutritionStore();
    const orchestrator = new SearchOrchestrator(store);
    const results = await orchestrator.search(query, Math.min(limit, 50));

    if (results.length === 0) {
      console.log("No results found.");
      store.close();
      return;
    }

    // Print as table
    console.log(
      "Name".padEnd(40) +
        "Cal".padStart(6) +
        "Pro".padStart(6) +
        "Fat".padStart(6) +
        "Carb".padStart(6) +
        "  Tier"
    );
    console.log("-".repeat(70));
    for (const r of results) {
      const name = (r.brand ? `${r.name} (${r.brand})` : r.name).slice(0, 39);
      console.log(
        name.padEnd(40) +
          fmt(r.calories).padStart(6) +
          fmt(r.protein).padStart(6) +
          fmt(r.fat).padStart(6) +
          fmt(r.carbs).padStart(6) +
          `  ${r.source_tier}`
      );
    }

    store.close();
  });

program
  .command("build-db")
  .description("Seed/rebuild the SQLite database from OpenNutrition dataset")
  .action(async () => {
    // Dynamic import to avoid loading yauzl unless needed
    const { seedDatabase } = await import("./seed.js");
    await seedDatabase();
  });

// Default: start MCP server
program
  .action(async () => {
    const { startServer } = await import("./mcp.js");
    await startServer();
  });

function fmt(n: number | null): string {
  return n != null ? n.toFixed(1) : "-";
}

program.parseAsync();

#!/usr/bin/env node
import { Command } from "commander";

import { NutritionStore } from "./store.js";
import { SearchOrchestrator } from "./search.js";
import { formatSearchTable } from "./cli-format.js";
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

    console.log(formatSearchTable(results));
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

program.parseAsync();

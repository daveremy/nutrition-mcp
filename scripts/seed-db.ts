#!/usr/bin/env tsx
import { seedDatabase } from "../src/seed.js";

seedDatabase().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

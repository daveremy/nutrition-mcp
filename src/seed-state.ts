export type SeedPhase = "idle" | "downloading" | "extracting" | "importing" | "indexing" | "done" | "failed";

const ACTIVE_PHASES = new Set<SeedPhase>(["downloading", "extracting", "importing", "indexing"]);

export interface SeedState {
  phase: SeedPhase;
  inserted: number;
  totalEstimate: number;
  error: string | null;
}

const TOTAL_ESTIMATE = 326_000;

const state: SeedState = {
  phase: "idle",
  inserted: 0,
  totalEstimate: TOTAL_ESTIMATE,
  error: null,
};

/** One-shot semaphore: prevents concurrent seedDatabase() runs. */
let seedingPromise: Promise<void> | null = null;

export function getSeedState(): Readonly<SeedState> {
  return state;
}

export function isSeeding(): boolean {
  return ACTIVE_PHASES.has(state.phase);
}

export function seedPercent(): number {
  return state.totalEstimate > 0 ? Math.round((state.inserted / state.totalEstimate) * 100) : 0;
}

export function seedProgressMessage(): string {
  const pct = seedPercent();
  switch (state.phase) {
    case "downloading": return "Local database is being downloaded (~60MB). Search results are limited to USDA API until this completes.";
    case "extracting": return "Local database is being extracted. Search results are limited to USDA API until this completes.";
    case "importing": return `Local database is ${pct}% imported (${state.inserted.toLocaleString()}/${state.totalEstimate.toLocaleString()} foods). Search results are limited to USDA API until this completes.`;
    case "indexing": return "Local database is building its search index. Almost ready.";
    default: return "";
  }
}

export function setSeedPhase(phase: SeedPhase): void {
  state.phase = phase;
  if (phase === "idle" || phase === "done") {
    state.error = null;
  }
}

export function setSeedInserted(count: number): void {
  state.inserted = count;
}

export function setSeedError(err: unknown): void {
  state.phase = "failed";
  state.error = err instanceof Error ? err.message : String(err);
}

/**
 * Start seeding if not already running. Returns the existing promise if
 * a seed is in progress (prevents concurrent seedDatabase() runs racing
 * on tmpDbPath and dataset.zip).
 */
export function startSeed(run: () => Promise<void>): Promise<void> {
  if (!seedingPromise) {
    seedingPromise = run().finally(() => { seedingPromise = null; });
  }
  return seedingPromise;
}

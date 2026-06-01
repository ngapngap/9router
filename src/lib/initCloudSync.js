import initializeApp from "@/shared/services/initializeApp";
// P09 (#21): startup hook không thuộc về user nào → bọc runAsSystem để
// getAdapter() được phép fallback default adapter (xem src/lib/db/driver.js).
import { runAsSystem } from "@/lib/saas/tenantContext.js";

// Survive Next.js HMR — module-level flag resets on reload, globalThis persists
// Latch pattern: persist success AND failure for a cooldown window so failed
// boots do not silently re-trigger init on every page render. P0 #21 follow-up.
const g = globalThis.__cloudSyncInit ??= { initialized: false, inProgress: null, lastError: null };
const FAILURE_COOLDOWN_MS = 30_000;

export async function ensureAppInitialized() {
  if (g.initialized) return true;
  if (g.inProgress) return g.inProgress;
  // Within failure cooldown, do not retry — surface the previous error.
  if (g.lastError && Date.now() - g.lastError.at < FAILURE_COOLDOWN_MS) {
    throw g.lastError.error;
  }
  g.inProgress = runAsSystem(async () => {
    try {
      await initializeApp();
      g.initialized = true;
      g.lastError = null;
    } catch (error) {
      console.error("[ServerInit] Error initializing app:", error?.message || error);
      g.lastError = { error, at: Date.now() };
      throw error;
    } finally {
      g.inProgress = null;
    }
  });
  return g.inProgress;
}

// Auto-initialize at runtime only, not during next build.
// Defer to next tick so HTTP server can accept connections before heavy init runs.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  setImmediate(() => {
    ensureAppInitialized().catch(console.log);
  });
}

export default ensureAppInitialized;

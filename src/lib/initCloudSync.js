import initializeApp from "@/shared/services/initializeApp";
// P09 (#21): startup hook không thuộc về user nào → bọc runAsSystem để
// getAdapter() được phép fallback default adapter (xem src/lib/db/driver.js).
import { runAsSystem } from "@/lib/saas/tenantContext.js";

// Survive Next.js HMR — module-level flag resets on reload, globalThis persists
const g = globalThis.__cloudSyncInit ??= { initialized: false, inProgress: null };

export async function ensureAppInitialized() {
  if (g.initialized) return true;
  if (g.inProgress) return g.inProgress;
  // P09 (#21): toàn bộ initializeApp() chạy trong system context — không tenant.
  g.inProgress = runAsSystem(async () => {
    try {
      await initializeApp();
      g.initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing app:", error?.message || error);
    } finally {
      g.inProgress = null;
    }
    return g.initialized;
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

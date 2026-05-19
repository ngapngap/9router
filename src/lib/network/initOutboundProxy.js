import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
// P09 (#21): startup hook không thuộc về user nào → bọc runAsSystem để
// getSettings() / getAdapter() được phép fallback default adapter trong SaaS mode.
import { runAsSystem } from "@/lib/saas/tenantContext.js";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  // P09 (#21): system caller — không có tenant context, runAsSystem để getAdapter() fallback OK.
  return runAsSystem(async () => {
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
      initialized = true;
    } catch (error) {
      console.error(`[ServerInit] Error initializing outbound proxy: ${error?.message || "unknown"}`);
    }

    return initialized;
  });
}

// Defer init so HTTP server accepts connections first
setImmediate(() => {
  ensureOutboundProxyInitialized().catch(console.log);
});

export default ensureOutboundProxyInitialized;

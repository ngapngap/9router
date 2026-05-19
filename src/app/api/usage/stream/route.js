import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer";
import { runWithTenant, setTenantUserId } from "@/lib/saas/tenantContext";

export const dynamic = "force-dynamic";

/**
 * SSE stream cho usage stats. P09 (#21): subscribe `statsEmitter` events filter
 * theo session userId trong SaaS mode để tránh leak cross-tenant. Self-host
 * mode (SAAS_ENABLED!=="true") không filter — payload userId == "_self_host"
 * cho cả emit và subscribe side.
 */
export async function GET() {
  const isSaas = process.env.SAAS_ENABLED === "true";
  const sessionUserId = isSaas ? await getSaasUserIdFromRequest() : null;

  if (isSaas && sessionUserId == null) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Wrap mọi DB-touching call vào runWithTenant để driver route đúng tenant.
  const withTenant = (fn) => {
    if (!isSaas) return fn();
    return runWithTenant(async () => {
      setTenantUserId(sessionUserId);
      return fn();
    });
  };

  // Filter event payload theo session user trong SaaS mode.
  const matchesUser = (payload) => {
    if (!isSaas) return true;
    return payload && payload.userId === sessionUserId;
  };

  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null, sendPending: null, cachedStats: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Full stats refresh (heavy) + immediate lightweight push
      state.send = async (payload) => {
        if (state.closed) return;
        if (!matchesUser(payload)) return;
        try {
          // Push lightweight update immediately so UI reflects changes fast
          if (state.cachedStats) {
            const { activeRequests, recentRequests, errorProvider } = await withTenant(() => getActiveRequests());
            const quickStats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`));
          }
          // Then do full recalc and update cache
          const stats = await withTenant(() => getUsageStats());
          state.cachedStats = stats;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      // Lightweight push: only refresh activeRequests + recentRequests on pending changes
      state.sendPending = async (payload) => {
        if (state.closed || !state.cachedStats) return;
        if (!matchesUser(payload)) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await withTenant(() => getActiveRequests());
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      // Initial push không có payload → matchesUser bypass bằng cách truyền sentinel.
      // Trong self-host mode bypass tự nhiên vì matchesUser trả true.
      // Trong SaaS mode, gọi với payload tự ráp để qua filter.
      const selfPayload = isSaas ? { userId: sessionUserId } : undefined;
      await state.send(selfPayload);

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

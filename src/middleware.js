// Next.js middleware — does NOT consume request body (unlike proxy.js convention).
// Renamed from proxy.js to fix body consumption issue in Next.js 16.
export { proxy as middleware, config } from "./dashboardGuard";

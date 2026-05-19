import initializeApp from "./shared/services/initializeApp.js";
// P09 (#21): startup entrypoint không thuộc về user nào → bọc runAsSystem để
// getAdapter() được phép fallback default adapter trong SaaS mode.
import { runAsSystem } from "./lib/saas/tenantContext.js";

async function startServer() {
  console.log("Starting server...");

  try {
    // P09 (#21): system caller — không có tenant context, runAsSystem để getAdapter() fallback OK.
    await runAsSystem(() => initializeApp());
    console.log("Server initialized");
  } catch (error) {
    console.log("Error initializing server:", error);
    process.exit(1);
  }
}

startServer().catch(console.log);

export default startServer;

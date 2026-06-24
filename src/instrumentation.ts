/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * We use it to launch the server-side hourly auto-sync so Customer/FR/Security
 * data stays fresh regardless of whether any browser tab is open.
 */
export async function register() {
  // Only in the Node.js server runtime (not edge, not the browser).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Allow opting out (e.g. CI/build) via env.
  if (process.env.DISABLE_AUTO_SYNC === "1") return;
  const { startAutoSync } = await import("@/lib/scheduler");
  await startAutoSync();
}

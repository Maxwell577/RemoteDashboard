// SentraRMM agent hub — entry point.
// Boots the socket.io broker + HTTP endpoints and the 3 simulated Windows
// agents, with graceful shutdown on SIGTERM/SIGINT.

import { Hub } from "./hub";

const hub = new Hub();
hub.start();

let closing = false;

function shutdown(sig: string): void {
  if (closing) return;
  closing = true;
  console.log(`[HUB] ${sig} received — shutting down…`);
  try {
    hub.stop();
  } catch (err) {
    console.error("[HUB] error during shutdown:", err);
  }
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Resilience: never let a stray error kill the hub.
process.on("uncaughtException", (err) => {
  console.error("[HUB] uncaught exception (continuing):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[HUB] unhandled rejection (continuing):", err);
});

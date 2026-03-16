import { RedisStreamProducer } from "./redis/producer";
import { TelemetryWebSocketServer } from "./websocket/server";

// ─── Configuration from environment ──────────────────────
const REDIS_HOST    = process.env.REDIS_HOST    ?? "localhost";
const REDIS_PORT    = parseInt(process.env.REDIS_PORT ?? "6379", 10);
const STREAM_KEY    = process.env.REDIS_STREAM_KEY ?? "telemetry:inbound";
const WS_PORT       = parseInt(process.env.WS_PORT ?? "8080", 10);
const MAX_CONN      = parseInt(process.env.MAX_CONNECTIONS ?? "10000", 10);

// ─── Bootstrap ───────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════");
  console.log("  PulseEngine · Ingestion Service v1.0.0  ");
  console.log("═══════════════════════════════════════════");

  const producer = new RedisStreamProducer(REDIS_HOST, REDIS_PORT, STREAM_KEY);
  const server = new TelemetryWebSocketServer(WS_PORT, producer, MAX_CONN);

  // Stats logging every 10 seconds
  setInterval(() => {
    const stats = server.getStats();
    console.log(
      `[Stats] Connections: ${stats.connections} | Messages ingested: ${stats.messagesIngested}`
    );
  }, 10_000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    await server.shutdown();
    await producer.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});

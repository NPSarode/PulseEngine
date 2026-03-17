import { createServer } from "http";
import { register, collectDefaultMetrics } from "prom-client";
import { RedisStreamProducer } from "./redis/producer";
import { TelemetryWebSocketServer } from "./websocket/server";

// ─── Configuration from environment ──────────────────────
const REDIS_HOST    = process.env.REDIS_HOST    ?? "localhost";
const REDIS_PORT    = parseInt(process.env.REDIS_PORT ?? "6379", 10);
const STREAM_KEY    = process.env.REDIS_STREAM_KEY ?? "telemetry:inbound";
const WS_PORT       = parseInt(process.env.WS_PORT ?? "8080", 10);
const MAX_CONN      = parseInt(process.env.MAX_CONNECTIONS ?? "10000", 10);

// Collect Node.js default metrics (CPU, memory, event loop lag, GC, etc.)
collectDefaultMetrics({ prefix: "pulse_ingestor_" });

// ─── Bootstrap ───────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════");
  console.log("  PulseEngine · Ingestion Service v1.1.0  ");
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

  // ── Prometheus metrics endpoint on port 9100 ────────────
  const metricsServer = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", register.contentType);
      res.end(await register.metrics());
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });
  metricsServer.listen(9100, () => {
    console.log("[Prometheus] Metrics endpoint listening on :9100/metrics");
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    metricsServer.close();
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

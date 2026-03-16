import { WebSocketServer, WebSocket, RawData } from "ws";
import { RedisStreamProducer, TelemetryEvent } from "../redis/producer";

interface IncomingTelemetry {
  sensorId: string;
  metricType: string;
  value: number;
  unit?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * TelemetryWebSocketServer — accepts concurrent sensor connections,
 * validates payloads, and pushes to Redis Streams with micro-batching.
 */
export class TelemetryWebSocketServer {
  private wss: WebSocketServer;
  private producer: RedisStreamProducer;
  private connectionCount = 0;
  private messageCount = 0;
  private readonly maxConnections: number;

  // Micro-batch buffer: flush every 50ms or 200 events
  private buffer: TelemetryEvent[] = [];
  private readonly BATCH_SIZE = 200;
  private readonly FLUSH_INTERVAL_MS = 50;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(port: number, producer: RedisStreamProducer, maxConnections: number) {
    this.producer = producer;
    this.maxConnections = maxConnections;

    this.wss = new WebSocketServer({
      port,
      maxPayload: 4096,             // 4KB max per message — sensors send small payloads
      perMessageDeflate: false,      // Disable compression for low-latency
    });

    this.setupHandlers();
    this.startFlushLoop();

    console.log(`[WS] Telemetry server listening on port ${port}`);
    console.log(`[WS] Max connections: ${maxConnections}`);
  }

  private setupHandlers(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      this.connectionCount++;

      if (this.connectionCount > this.maxConnections) {
        ws.close(1013, "Max connections exceeded");
        this.connectionCount--;
        return;
      }

      ws.on("message", (data: RawData) => this.handleMessage(ws, data));

      ws.on("close", () => {
        this.connectionCount--;
      });

      ws.on("error", (err) => {
        console.error("[WS] Socket error:", err.message);
      });
    });

    this.wss.on("error", (err) => {
      console.error("[WS] Server error:", err.message);
    });
  }

  private handleMessage(ws: WebSocket, raw: RawData): void {
    let payload: IncomingTelemetry;

    try {
      payload = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // ── Validation ───────────────────────────────────────
    if (!payload.sensorId || typeof payload.sensorId !== "string") {
      ws.send(JSON.stringify({ error: "Missing or invalid sensorId" }));
      return;
    }
    if (!payload.metricType || typeof payload.metricType !== "string") {
      ws.send(JSON.stringify({ error: "Missing or invalid metricType" }));
      return;
    }
    if (typeof payload.value !== "number" || !isFinite(payload.value)) {
      ws.send(JSON.stringify({ error: "Missing or invalid value" }));
      return;
    }

    // ── Build Event ──────────────────────────────────────
    const event: TelemetryEvent = {
      sensorId: payload.sensorId,
      metricType: payload.metricType,
      value: payload.value,
      unit: payload.unit,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      metadata: payload.metadata ? JSON.stringify(payload.metadata) : undefined,
    };

    // Push to micro-batch buffer
    this.buffer.push(event);
    this.messageCount++;

    // Flush immediately if batch threshold hit
    if (this.buffer.length >= this.BATCH_SIZE) {
      this.flush();
    }

    // ACK back to sensor
    ws.send(JSON.stringify({ ack: true, sensorId: event.sensorId }));
  }

  /**
   * Micro-batch flush loop — ensures events are pushed even
   * under low throughput (doesn't wait for full batch).
   */
  private startFlushLoop(): void {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush();
      }
    }, this.FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Swap buffer atomically to avoid blocking incoming writes
    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.producer.pushBatch(batch);
    } catch (err) {
      console.error(`[WS] Failed to flush ${batch.length} events:`, (err as Error).message);
      // Re-queue failed events at the front of the buffer
      this.buffer.unshift(...batch);
    }
  }

  getStats(): { connections: number; messagesIngested: number } {
    return {
      connections: this.connectionCount,
      messagesIngested: this.messageCount,
    };
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);

    // Final flush
    await this.flush();

    return new Promise((resolve) => {
      this.wss.close(() => {
        console.log("[WS] Server shut down");
        resolve();
      });
    });
  }
}

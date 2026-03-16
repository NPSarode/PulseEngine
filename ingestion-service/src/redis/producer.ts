import Redis from "ioredis";

/**
 * RedisStreamProducer — pushes validated telemetry events into a Redis Stream.
 *
 * Uses XADD with MAXLEN~ to apply approximate stream trimming,
 * keeping backpressure bounded without blocking writes.
 */
export interface TelemetryEvent {
  sensorId: string;
  metricType: string;
  value: number;
  unit?: string;
  timestamp: string;        // ISO-8601 from sensor
  metadata?: string;        // JSON-stringified extra fields
}

export class RedisStreamProducer {
  private client: Redis;
  private readonly streamKey: string;
  private readonly maxLen: number;

  constructor(host: string, port: number, streamKey: string, maxLen = 1_000_000) {
    this.client = new Redis({ host, port, maxRetriesPerRequest: 3 });
    this.streamKey = streamKey;
    this.maxLen = maxLen;

    this.client.on("error", (err) => {
      console.error("[Redis] Connection error:", err.message);
    });

    this.client.on("connect", () => {
      console.log(`[Redis] Connected to ${host}:${port}`);
    });
  }

  /**
   * Push a single telemetry event to the stream.
   * Uses '*' for auto-generated stream ID (timestamp-based).
   * MAXLEN~ provides approximate trimming — O(1) amortized.
   */
  async push(event: TelemetryEvent): Promise<string> {
    const fields: string[] = [
      "sensorId",   event.sensorId,
      "metricType",  event.metricType,
      "value",       String(event.value),
      "timestamp",   event.timestamp,
    ];

    if (event.unit) {
      fields.push("unit", event.unit);
    }
    if (event.metadata) {
      fields.push("metadata", event.metadata);
    }

    // XADD streamKey MAXLEN ~ maxLen * field1 val1 field2 val2 ...
    const id = await this.client.xadd(
      this.streamKey,
      "MAXLEN", "~", String(this.maxLen),
      "*",
      ...fields
    );

    return id!;
  }

  /**
   * Push a batch of events using a Redis pipeline.
   * Reduces round-trips — critical at 10k+ events/sec.
   */
  async pushBatch(events: TelemetryEvent[]): Promise<string[]> {
    const pipeline = this.client.pipeline();

    for (const event of events) {
      const fields: string[] = [
        "sensorId",   event.sensorId,
        "metricType",  event.metricType,
        "value",       String(event.value),
        "timestamp",   event.timestamp,
      ];

      if (event.unit) {
        fields.push("unit", event.unit);
      }
      if (event.metadata) {
        fields.push("metadata", event.metadata);
      }

      pipeline.xadd(
        this.streamKey,
        "MAXLEN", "~", String(this.maxLen),
        "*",
        ...fields
      );
    }

    const results = await pipeline.exec();
    return (results ?? []).map(([err, id]) => {
      if (err) throw err;
      return id as string;
    });
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    console.log("[Redis] Disconnected");
  }
}

# API Reference

## Table of Contents

- [Overview](#overview)
- [WebSocket — Ingestion Service](#websocket--ingestion-service)
- [SignalR Hub — Processing Service](#signalr-hub--processing-service)
- [HTTP Metrics Endpoints](#http-metrics-endpoints)
- [Redis Structures](#redis-structures)
- [Data Models](#data-models)

---

## Overview

PulseEngine exposes three interface types:

| Interface | Service | Port | Protocol | Purpose |
|-----------|---------|------|----------|---------|
| WebSocket | Ingestion | 8085 | WS | Sensor telemetry intake |
| SignalR Hub | Processing | 5050 | WS/HTTP | Real-time dashboard push |
| HTTP Metrics | Ingestion, Processing | 9100, 5050 | HTTP | Prometheus scrape endpoints |

There are no traditional REST APIs — PulseEngine is fully event-driven.

---

## WebSocket — Ingestion Service

### Connection

```
URL: ws://localhost:8085
Protocol: WebSocket (RFC 6455)
Max Connections: 10,000 (configurable via INGESTOR_MAX_CONNECTIONS)
Max Payload: 4KB per message
```

### Sending Telemetry

**Direction:** Client (Sensor) → Server (Ingestor)

**Request Format:**

```json
{
  "sensorId": "TEMP-FLOOR3-001",
  "metricType": "temperature",
  "value": 72.5,
  "unit": "°C",
  "timestamp": "2026-03-17T12:00:00.000Z",
  "metadata": {
    "location": "Building-A",
    "floor": 3,
    "firmware": "v2.1.4"
  }
}
```

**Field Specifications:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sensorId` | string | Yes | Unique device identifier (e.g., `TEMP-FLOOR3-001`) |
| `metricType` | string | Yes | Signal category (e.g., `temperature`, `pressure`, `humidity`) |
| `value` | number | Yes | Sensor reading (must be a finite number) |
| `unit` | string | No | Measurement unit (e.g., `°C`, `PSI`, `%RH`) |
| `timestamp` | string (ISO-8601) | No | Sensor recording time. Defaults to server time if omitted. |
| `metadata` | object | No | Arbitrary key-value data. Stringified to JSON for storage. |

### Acknowledgement

**Direction:** Server (Ingestor) → Client (Sensor)

On successful validation:
```json
{
  "ack": true,
  "sensorId": "TEMP-FLOOR3-001"
}
```

### Validation Errors

Invalid payloads receive an error response and are **never forwarded to Redis**.

**Missing required field:**
```json
{
  "error": "Missing required field: sensorId"
}
```

**Invalid value:**
```json
{
  "error": "Invalid value: must be a finite number"
}
```

**JSON parse error:**
```json
{
  "error": "Invalid JSON payload"
}
```

### Connection Lifecycle

```
Client                           Server (Ingestor)
  │                                     │
  │──── WebSocket Upgrade ─────────────▶│
  │◀─── 101 Switching Protocols ────────│
  │                                     │
  │──── JSON telemetry event ──────────▶│  ← Validated, buffered
  │◀─── {"ack": true, "sensorId":...} ─│  ← Acknowledged
  │                                     │
  │──── JSON telemetry event ──────────▶│  ← Invalid payload
  │◀─── {"error": "Missing..."} ────────│  ← Error response
  │                                     │
  │──── close ─────────────────────────▶│
  │◀─── close ──────────────────────────│
```

### Usage Examples

**JavaScript (Browser/Node.js):**

```javascript
const ws = new WebSocket("ws://localhost:8085");

ws.onopen = () => {
  ws.send(JSON.stringify({
    sensorId: "TEMP-FLOOR3-001",
    metricType: "temperature",
    value: 72.5,
    unit: "°C",
    timestamp: new Date().toISOString(),
    metadata: { location: "Building-A", floor: 3 }
  }));
};

ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  if (response.ack) {
    console.log(`ACK: ${response.sensorId}`);
  } else if (response.error) {
    console.error(`Error: ${response.error}`);
  }
};

ws.onerror = (error) => console.error("WebSocket error:", error);
ws.onclose = () => console.log("Connection closed");
```

**Python:**

```python
import asyncio
import websockets
import json
from datetime import datetime

async def send_telemetry():
    async with websockets.connect("ws://localhost:8085") as ws:
        event = {
            "sensorId": "TEMP-FLOOR3-001",
            "metricType": "temperature",
            "value": 72.5,
            "unit": "°C",
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
        await ws.send(json.dumps(event))
        response = await ws.recv()
        print(f"Response: {response}")

asyncio.run(send_telemetry())
```

**cURL (via websocat):**

```bash
echo '{"sensorId":"TEMP-001","metricType":"temperature","value":72.5}' | \
  websocat ws://localhost:8085
```

### High-Throughput Pattern

```javascript
const ws = new WebSocket("ws://localhost:8085");

ws.onopen = () => {
  const sensors = ["TEMP-001", "TEMP-002", "PRESS-001", "HUM-001"];

  setInterval(() => {
    for (let i = 0; i < 100; i++) {
      ws.send(JSON.stringify({
        sensorId: sensors[Math.floor(Math.random() * sensors.length)],
        metricType: "temperature",
        value: 50 + Math.random() * 40,
        unit: "°C",
        timestamp: new Date().toISOString()
      }));
    }
  }, 10); // ~10,000 events/sec
};
```

---

## SignalR Hub — Processing Service

### Connection

```
URL:      http://localhost:5050/hub/telemetry
Protocol: SignalR (WebSocket transport)
Library:  @microsoft/signalr (npm) or Microsoft.AspNetCore.SignalR.Client (.NET)
```

### Server-to-Client Events

#### `ReceiveTelemetryBatch`

Fired after each batch is processed. Contains all telemetry events from the batch.

**Payload:** `TelemetryEvent[]`

```json
[
  {
    "sensorId": "TEMP-FLOOR3-001",
    "metricType": "temperature",
    "value": 72.5,
    "unit": "°C",
    "timestamp": "2026-03-17T12:00:00.000Z"
  },
  {
    "sensorId": "PRESS-MAIN-002",
    "metricType": "pressure",
    "value": 105.3,
    "unit": "PSI",
    "timestamp": "2026-03-17T12:00:00.050Z"
  }
]
```

**Field Descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `sensorId` | string | Device identifier |
| `metricType` | string | Signal category |
| `value` | number | Sensor reading |
| `unit` | string | Measurement unit |
| `timestamp` | string (ISO-8601) | Recording time |

**Frequency:** Once per processor batch cycle (every ~50-2000ms depending on event rate)

---

#### `ReceiveAlert`

Fired for each threshold violation that passes the cooldown filter (max 1 per sensor per 30 seconds).

**Payload:** `ThresholdAlert`

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "sensorId": "TEMP-FLOOR3-001",
  "metricType": "temperature",
  "thresholdValue": 85.0,
  "actualValue": 91.3,
  "severity": "CRITICAL",
  "message": "temperature value 91.3 exceeds upper threshold 85.0",
  "triggeredAt": "2026-03-17T12:00:01.123Z"
}
```

**Field Descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (GUID) | Unique alert identifier |
| `sensorId` | string | Device that triggered the alert |
| `metricType` | string | Which metric breached the threshold |
| `thresholdValue` | number | Configured boundary that was exceeded |
| `actualValue` | number | The reading that exceeded the boundary |
| `severity` | string | `"CRITICAL"` or `"WARNING"` |
| `message` | string | Human-readable description |
| `triggeredAt` | string (ISO-8601) | When the threshold was exceeded |

**Threshold Configuration:**

| Metric | Low Threshold | High Threshold | Severity |
|--------|:---:|:---:|----------|
| temperature | -10.0°C | 85.0°C | CRITICAL |
| pressure | — | 150.0 PSI | CRITICAL |
| humidity | — | 95.0 %RH | CRITICAL |

---

### Connection Examples

**JavaScript (@microsoft/signalr):**

```javascript
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";

const connection = new HubConnectionBuilder()
  .withUrl("http://localhost:5050/hub/telemetry")
  .withAutomaticReconnect()
  .configureLogging(LogLevel.Information)
  .build();

connection.on("ReceiveTelemetryBatch", (events) => {
  console.log(`Received ${events.length} events`);
  events.forEach(e => {
    console.log(`  ${e.sensorId}: ${e.value} ${e.unit}`);
  });
});

connection.on("ReceiveAlert", (alert) => {
  console.log(`ALERT [${alert.severity}] ${alert.sensorId}: ${alert.message}`);
});

connection.onreconnecting(() => console.log("Reconnecting..."));
connection.onreconnected(() => console.log("Reconnected"));
connection.onclose(() => console.log("Connection closed"));

await connection.start();
console.log("Connected to SignalR hub");
```

**C# (.NET Client):**

```csharp
using Microsoft.AspNetCore.SignalR.Client;

var connection = new HubConnectionBuilder()
    .WithUrl("http://localhost:5050/hub/telemetry")
    .WithAutomaticReconnect()
    .Build();

connection.On<List<TelemetryEvent>>("ReceiveTelemetryBatch", events =>
{
    Console.WriteLine($"Received {events.Count} events");
});

connection.On<ThresholdAlert>("ReceiveAlert", alert =>
{
    Console.WriteLine($"ALERT [{alert.Severity}] {alert.SensorId}: {alert.Message}");
});

await connection.StartAsync();
```

---

## HTTP Metrics Endpoints

### Ingestion Service Metrics

```
GET http://localhost:9100/metrics
Content-Type: text/plain; version=0.0.4
```

**Custom Metrics:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pulse_ws_connections_active` | Gauge | — | Currently active WebSocket connections |
| `pulse_ws_messages_received_total` | Counter | — | Total messages received from sensors |
| `pulse_redis_pushes_total` | Counter | — | Total events pushed to Redis Stream |
| `pulse_batch_flush_duration_seconds` | Histogram | — | Time to execute Redis pipeline batch |

**Auto-collected Node.js Metrics (via prom-client):**

| Metric | Type | Description |
|--------|------|-------------|
| `nodejs_heap_size_total_bytes` | Gauge | V8 heap total |
| `nodejs_heap_size_used_bytes` | Gauge | V8 heap used |
| `nodejs_eventloop_lag_seconds` | Gauge | Event loop lag |
| `nodejs_active_handles_total` | Gauge | Active libuv handles |
| `nodejs_gc_duration_seconds` | Histogram | GC pause duration |

---

### Processing Service Metrics

```
GET http://localhost:5050/metrics
Content-Type: text/plain; version=0.0.4
```

**Custom Metrics:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pulse_events_processed_total` | Counter | — | Total events successfully processed |
| `pulse_batch_size` | Histogram | — | Number of events per processing batch |
| `pulse_processing_duration_seconds` | Histogram | — | Full batch processing duration |
| `pulse_db_write_duration_seconds` | Histogram | — | TimescaleDB COPY write duration |
| `pulse_alerts_generated_total` | Counter | — | Total threshold alerts created |
| `pulse_signalr_connections` | Gauge | — | Active SignalR (dashboard) connections |
| `pulse_dlq_messages_total` | Counter | — | Total messages routed to DLQ |
| `pulse_dlq_length` | Gauge | — | Current DLQ queue size |

---

### Prometheus Scrape Configuration

Prometheus scrapes both services every 15 seconds:

```yaml
scrape_configs:
  - job_name: 'processor'
    scrape_interval: 15s
    static_configs:
      - targets: ['processor:5050']

  - job_name: 'ingestor'
    scrape_interval: 15s
    static_configs:
      - targets: ['ingestor:9100']
```

### Example PromQL Queries

```promql
# Events processed per second (rate over 1 minute)
rate(pulse_events_processed_total[1m])

# P95 processing latency
histogram_quantile(0.95, rate(pulse_processing_duration_seconds_bucket[5m]))

# P99 DB write latency
histogram_quantile(0.99, rate(pulse_db_write_duration_seconds_bucket[5m]))

# Active WebSocket connections
pulse_ws_connections_active

# Active SignalR dashboard connections
pulse_signalr_connections

# Alert rate per second
rate(pulse_alerts_generated_total[1m])

# DLQ growth rate
rate(pulse_dlq_messages_total[5m])

# Node.js event loop lag
pulse_ingestor_nodejs_eventloop_lag_seconds

# Node.js heap memory usage
nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes
```

---

## Redis Structures

### Stream: `telemetry:inbound`

**Type:** Stream
**Max Length:** ~1,000,000 entries (approximate trim via `MAXLEN ~`)

**Entry Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `sensorId` | string | Device identifier |
| `metricType` | string | Signal category |
| `value` | string | Sensor reading (stored as string, parsed by processor) |
| `unit` | string | Measurement unit (may be absent) |
| `timestamp` | string | ISO-8601 timestamp |
| `metadata` | string | JSON-stringified metadata object (may be absent) |

**Consumer Group:** `pulse-processors`
- Created automatically on first processor startup
- Supports multiple consumers (horizontal scaling)
- Events acknowledged after successful processing

**Inspection Commands:**

```bash
# Stream length
docker exec pulse-redis redis-cli XLEN telemetry:inbound

# Read latest 5 entries
docker exec pulse-redis redis-cli XREVRANGE telemetry:inbound + - COUNT 5

# Consumer group info
docker exec pulse-redis redis-cli XINFO GROUPS telemetry:inbound

# Pending (unacknowledged) entries
docker exec pulse-redis redis-cli XPENDING telemetry:inbound pulse-processors
```

---

### List: `telemetry_errors` (Dead Letter Queue)

**Type:** List (LPUSH ordering — newest first)
**TTL:** None (persists until manually cleared)

**Entry Format:**

```json
{
  "StreamEntryId": "1710000000000-0",
  "RawData": {
    "sensorId": "TEMP-001",
    "metricType": "temperature",
    "value": "NaN"
  },
  "ErrorReason": "Unparseable value: 'NaN'",
  "ExceptionType": "System.FormatException",
  "Timestamp": "2026-03-17T12:00:00.000Z",
  "Source": "TelemetryConsumerWorker"
}
```

**Inspection Commands:**

```bash
# View latest 10 DLQ entries
docker exec pulse-redis redis-cli LRANGE telemetry_errors 0 9

# Total DLQ size
docker exec pulse-redis redis-cli LLEN telemetry_errors

# Clear DLQ after inspection
docker exec pulse-redis redis-cli DEL telemetry_errors
```

---

## Data Models

### TelemetryEvent (C# Domain Model)

```csharp
public sealed class TelemetryEvent
{
    public required string SensorId { get; init; }
    public required string MetricType { get; init; }
    public required double Value { get; init; }
    public string? Unit { get; init; }
    public required DateTimeOffset Timestamp { get; init; }
    public string? Metadata { get; init; }
}
```

### ThresholdAlert (C# Domain Model)

```csharp
public sealed class ThresholdAlert
{
    public required string SensorId { get; init; }
    public required string MetricType { get; init; }
    public required double ThresholdValue { get; init; }
    public required double ActualValue { get; init; }
    public string Severity { get; init; } = "WARNING";
    public string? Message { get; init; }
    public DateTimeOffset TriggeredAt { get; init; } = DateTimeOffset.UtcNow;
}
```

### TypeScript Interfaces (Frontend)

```typescript
interface TelemetryEvent {
  sensorId: string;
  metricType: string;
  value: number;
  unit?: string;
  timestamp: string;
}

interface ThresholdAlert {
  id: string;
  sensorId: string;
  metricType: string;
  thresholdValue: number;
  actualValue: number;
  severity: "CRITICAL" | "WARNING";
  message: string;
  triggeredAt: string;
}
```

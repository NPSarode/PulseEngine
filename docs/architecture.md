# Architecture & Design Decisions

## Table of Contents

- [System Architecture](#system-architecture)
- [Design Principles](#design-principles)
- [Service Architecture](#service-architecture)
  - [Ingestion Service](#ingestion-service)
  - [Processing Service](#processing-service)
  - [Frontend Dashboard](#frontend-dashboard)
  - [Sensor Simulator](#sensor-simulator)
- [Data Flow](#data-flow)
- [Communication Patterns](#communication-patterns)
- [Technology Decisions](#technology-decisions)
- [Performance Architecture](#performance-architecture)
- [Failure Handling](#failure-handling)
- [Scalability Model](#scalability-model)

---

## System Architecture

PulseEngine follows an **event-driven microservices** architecture with clear separation of concerns: ingestion → buffering → processing → persistence → visualization.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          PulseEngine Architecture                            │
│                                                                              │
│  ┌─────────────────┐     ┌───────────────────┐     ┌─────────────────────┐  │
│  │   IoT Sensors    │────▶│  Ingestion Service │────▶│    Redis Streams    │  │
│  │   (10,000+)      │ WS  │  (Node.js 20)      │XADD│  telemetry:inbound  │  │
│  └─────────────────┘     └───────────────────┘     └────────┬────────────┘  │
│         ▲                    │                               │               │
│         │                    │ metrics:9100                  │ XREADGROUP    │
│  ┌──────┴──────┐             ▼                               ▼               │
│  │  Simulator   │     ┌────────────┐              ┌───────────────────────┐  │
│  │  (Phase FSM) │     │ Prometheus │◀─ scrape ───│  Processing Service    │  │
│  └─────────────┘     │   :9090    │   :5050      │  (.NET Core 8)         │  │
│                       └─────┬──────┘              │                       │  │
│                             │                     │  ┌─────────────────┐  │  │
│                       ┌─────▼──────┐              │  │ Threshold Engine│  │  │
│                       │  Grafana   │              │  │ (30s cooldown)  │  │  │
│                       │   :3001    │              │  └────────┬────────┘  │  │
│                       └────────────┘              └──────┬────┼──────────┘  │
│                                                         │    │              │
│                                              ┌──────────┘    └──────────┐   │
│                                              ▼                          ▼   │
│                                   ┌──────────────────┐       ┌────────────┐ │
│                                   │   TimescaleDB    │       │ SignalR Hub │ │
│                                   │   (PostgreSQL 16)│       │ (WebSocket) │ │
│                                   │                  │       └──────┬─────┘ │
│                                   │  • Hypertable    │              │       │
│                                   │  • Compression   │              ▼       │
│                                   │  • Aggregates    │       ┌────────────┐ │
│                                   │  • Retention     │       │ Dashboard  │ │
│                                   └──────────────────┘       │ React+D3   │ │
│                                                              │  :3000     │ │
│                                                              └────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────┐                    │
│  │  Dead Letter Queue: Redis list `telemetry_errors`    │                    │
│  │  (malformed events stored for inspection/replay)     │                    │
│  └──────────────────────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Design Principles

### 1. Event-Driven Decoupling
Services communicate through Redis Streams, not direct calls. The ingestion service doesn't know (or care) about the processing service — it just writes to the stream. This decoupling enables independent scaling, deployment, and failure isolation.

### 2. Backpressure Management
Redis Streams with `MAXLEN ~ 1000000` provides a bounded buffer. If the processor falls behind, the stream acts as a shock absorber. If the stream reaches capacity, approximate trimming removes the oldest entries — preferring data freshness over completeness.

### 3. At-Least-Once Delivery
Consumer groups with explicit ACK ensure no events are lost during processing failures. Unacknowledged events are re-delivered on processor restart. The Dead Letter Queue captures events that repeatedly fail parsing.

### 4. Push Over Pull
SignalR WebSocket push eliminates polling latency. Data reaches the dashboard within milliseconds of processing — not seconds. This is critical for threshold alerts where operator response time matters.

### 5. Batch Everything
Individual operations are expensive at scale. PulseEngine batches at every layer:
- **Ingestion:** Micro-batch 200 events before Redis pipeline flush
- **Processing:** Read up to 100 events per consumer group poll
- **Persistence:** Binary COPY bulk import (not row-by-row INSERT)
- **Frontend:** 100ms render batching (not per-event React updates)

---

## Service Architecture

### Ingestion Service

**Runtime:** Node.js 20 (Alpine)
**Language:** TypeScript
**Ports:** 8085 (WebSocket), 9100 (Prometheus metrics)

```
                    WebSocket connections (up to 10,000)
                              │
                              ▼
                    ┌─────────────────────┐
                    │   WS Server (ws)    │
                    │   - validate payload│
                    │   - parse JSON      │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Micro-batch Buffer│
                    │   flush: 50ms OR    │
                    │   200 events        │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Redis Producer    │
                    │   pipeline.xadd()   │
                    │   MAXLEN ~ 1000000  │
                    └─────────────────────┘
```

**Why Node.js?** Single-threaded event loop is ideal for high-concurrency, low-compute I/O workloads. Each WebSocket connection costs ~30KB memory vs ~1MB for thread-per-connection models. Node.js can sustain 10,000+ concurrent connections on a single core.

**Why Micro-batching?** At 10,000 events/sec, individual `XADD` calls would generate 10,000 network round-trips/sec. Micro-batching (50ms / 200 events) reduces this to ~50 pipelined batch calls — a 200x reduction in network overhead.

### Processing Service

**Runtime:** .NET Core 8 (Alpine)
**Language:** C#
**Ports:** 5050 (HTTP + WebSocket + Prometheus)

```
┌──────────────────────────────────────────────────────────────┐
│                    Processing Service                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  TelemetryConsumerWorker (BackgroundService)             ││
│  │                                                         ││
│  │  while (true) {                                         ││
│  │    1. XREADGROUP (up to 100 events, 2s block)           ││
│  │    2. Parse → TelemetryEvent[]                          ││
│  │    3. ThresholdAlertService.Evaluate()                   ││
│  │    4. TimescaleDbService.InsertTelemetryBatchAsync()     ││
│  │    5. TimescaleDbService.InsertAlertsAsync()             ││
│  │    6. SignalR broadcast: ReceiveTelemetryBatch            ││
│  │    7. SignalR broadcast: ReceiveAlert (per alert)        ││
│  │    8. StreamAcknowledgeAsync() — ACK batch               ││
│  │  }                                                      ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌────────────────────┐  ┌────────────────────────────────┐ │
│  │  ThresholdAlert     │  │  TimescaleDbService            │ │
│  │  Service            │  │  - Npgsql Binary COPY          │ │
│  │  - in-memory lookup │  │  - 50k-100k rows/sec           │ │
│  │  - 30s cooldown     │  │  - parameterized alert INSERT  │ │
│  └────────────────────┘  └────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────┐  ┌────────────────────────────────┐ │
│  │  DeadLetterService  │  │  TelemetryHub (SignalR)        │ │
│  │  - LPUSH to DLQ    │  │  - /hub/telemetry              │ │
│  │  - error capture   │  │  - real-time dashboard push     │ │
│  └────────────────────┘  └────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Why .NET Core 8?** High-performance runtime with low GC pause times. `IHostedService` pattern is purpose-built for long-running consumer loops. Strong typing prevents data corruption in the critical processing pipeline.

**Why SignalR over custom WebSocket?** SignalR provides automatic reconnection, connection lifecycle management, hub pattern for method routing, and native .NET DI integration — all built-in. Custom WebSocket would require reimplementing all of this.

### Frontend Dashboard

**Runtime:** Nginx (Alpine) serving Vite-built React app
**Framework:** React 18 + TypeScript
**Port:** 3000

```
┌─────────────────────────────────────────────────────────┐
│  App.tsx — 3-Row Industrial Dashboard                    │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Header: Connection status • EMA throughput (evt/s) ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Row 1: GaugeRing[] │ Active Sensors │ Active Alerts││
│  │         (SVG radial) │ Alerting Count │ Throughput   ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌────────────────────────────┬────────────────────────┐│
│  │  Row 2: TelemetryChart[]  │  LiveAlertFeed          ││
│  │  (D3.js, top 4 sensors)   │  (scrollable, ACK)      ││
│  │  60s sliding window        │  All/Active/ACK'd tabs  ││
│  └────────────────────────────┴────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Row 3: SensorCard[] grid (all sensors)              ││
│  │  Green (normal) ↔ Red (alert) with animated ping     ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Data Flow:**
1. `useSignalR` hook establishes connection to `/hub/telemetry`
2. Events accumulate in `bufferRef` (avoids per-event state updates)
3. `setInterval` flushes buffer to Zustand store every 100ms
4. EMA (α=0.3) smooths throughput counter display
5. Zustand selectors trigger only affected components to re-render
6. D3.js directly manipulates SVG for chart updates

**Why D3.js over Chart.js/Recharts?** Pre-built chart libraries cannot support real-time 60-second sliding windows with crosshair snap-to-point tooltips, threshold zone overlays, and CatmullRom interpolation. D3 gives full SVG control at 60fps.

**Why Zustand over Redux?** Lightweight (< 1KB), no boilerplate, built-in selectors. The store has a flat shape — streams, sensors, alerts — which Zustand handles perfectly. Redux's action/reducer ceremony adds complexity with zero benefit here.

### Sensor Simulator

**Runtime:** Node.js 20 (Alpine)
**Language:** JavaScript

The simulator implements a **Phase-Based Finite State Machine** that generates realistic sensor behavior patterns:

```
    ┌──────────┐   8%    ┌───────────┐   40%   ┌─────────┐
    │  NORMAL  │────────▶│  CLIMBING  │────────▶│  SPIKE  │
    │ (safe)   │◀────────│ (rising)   │   60%   │ (alert) │
    └──────────┘  back   └───────────┘  back    └────┬────┘
         ▲                                           │
         │         ┌────────────┐         25%        │
         └─────────│ RECOVERING │◀───────────────────┤
                   │ (dropping) │         75%        │
                   └────────────┘    (direct)        ▼
                                              ┌───────────┐
                                              │  CRITICAL  │
                         2% (temp only)       │ (sustained)│
    NORMAL ──────────────▶ LOW_SPIKE          └───────────┘
```

This creates natural patterns: sensors drift upward, spike above thresholds (triggering alerts), sustain critical readings, then recover — mimicking real industrial scenarios.

---

## Data Flow

### Real-Time Path (Sensor → Dashboard)

```
Step  Latency    Operation
────  ─────────  ──────────────────────────────────────────────
 1    ~1ms       Sensor sends JSON via WebSocket
 2    ~1ms       Ingestor validates payload fields
 3    ~50ms      Micro-batch buffer fills (50ms or 200 events)
 4    ~2ms       Redis pipeline XADD (batch flush)
 5    ≤2000ms    Processor XREADGROUP (2s block timeout, returns on data)
 6    ~1ms       Parse Redis entries → TelemetryEvent objects
 7    ~1µs       In-memory threshold evaluation (dictionary lookup)
 8    ~5ms       TimescaleDB binary COPY (batch persistence)
 9    ~1ms       SignalR broadcast to all dashboards
10    ~100ms     React 100ms render batch + D3.js redraw
────  ─────────  ──────────────────────────────────────────────
      ~150-200ms Total end-to-end latency (typical)
```

### Alert Path

```
Telemetry event enters Processor
         │
         ▼
Value exceeds configured threshold?
         │
    YES  ▼
Sensor in 30-second cooldown?
         │
    NO   ▼
ThresholdAlert created (severity: CRITICAL)
         │
         ├──▶ INSERT into alerts table
         ├──▶ SignalR ReceiveAlert broadcast
         └──▶ Prometheus counter incremented
                    │
                    ▼
Dashboard: LiveAlertFeed + SensorCard turns red
```

### Dead Letter Path

```
Redis Stream entry arrives
         │
         ▼
Parse attempt fails (missing field / bad value)
         │
         ▼
DeadLetterService.PushAsync()
         │
         ├──▶ LPUSH telemetry_errors (Redis list)
         ├──▶ Prometheus pulse_dlq_messages_total++
         └──▶ ACK original entry (prevent infinite re-delivery)
```

---

## Communication Patterns

| From → To | Protocol | Pattern | Payload |
|-----------|----------|---------|---------|
| Sensor → Ingestor | WebSocket (JSON) | Persistent connection, per-event messages | TelemetryEvent JSON |
| Ingestor → Redis | XADD (pipelined) | Micro-batched, at-most-once per pipeline call | Hash fields per entry |
| Redis → Processor | XREADGROUP | Consumer group, at-least-once with ACK | Stream entries |
| Processor → TimescaleDB | Binary COPY | Bulk batch write | Binary row data |
| Processor → Dashboard | SignalR (WebSocket) | Server-push broadcast | JSON arrays/objects |
| Processor → DLQ | LPUSH | Append-only error log | JSON error entry |
| Prometheus → Services | HTTP GET /metrics | Pull-based scrape (15s interval) | OpenMetrics text |
| Dashboard → Processor | SignalR | Bi-directional connection (hub) | Method invocations |

---

## Technology Decisions

### Why Redis Streams Over Alternatives

| Alternative | Why Rejected |
|-------------|-------------|
| **Kafka** | Overkill for single-node deployment. Redis Streams provides the same consumer group semantics with 10x less operational complexity. No ZooKeeper/KRaft, no partition rebalancing. |
| **Redis Pub/Sub** | Fire-and-forget — if the processor is down, events are lost. Streams persist events and support replay. |
| **RabbitMQ** | Additional infrastructure component. Redis is already needed for DLQ. Streams + consumer groups cover the messaging needs. |
| **Direct WebSocket** | No buffering between services. Tight coupling. No replay capability on failure. |

### Why TimescaleDB Over Alternatives

| Alternative | Why Rejected |
|-------------|-------------|
| **Standard PostgreSQL** | No automatic chunking, compression, or continuous aggregates. Tables degrade under high-velocity time-series writes. |
| **InfluxDB** | Custom query language (Flux), weaker ecosystem. TimescaleDB uses standard SQL on top of PostgreSQL. |
| **MongoDB** | No native time-series optimizations pre-v5. No SQL. No hypertable equivalents for automatic lifecycle management. |
| **ClickHouse** | Excellent for analytics, but requires separate tooling. TimescaleDB runs on familiar PostgreSQL with full SQL support. |

### Why SignalR Over Alternatives

| Alternative | Why Rejected |
|-------------|-------------|
| **Socket.io** | Requires a separate Node.js relay service. SignalR integrates natively with .NET DI, middleware, and hub patterns. |
| **Server-Sent Events** | Unidirectional. Cannot support client-to-server acknowledgements or method invocations. |
| **gRPC Streaming** | Requires protobuf schemas, code generation. Overkill for dashboard push. Not natively supported in browsers without a proxy. |
| **REST Polling** | 1-second polling = 1-second latency floor. Wastes bandwidth on empty responses. |

---

## Performance Architecture

### Optimization Stack

| Layer | Technique | Impact |
|-------|-----------|--------|
| Ingestion | Micro-batching (50ms / 200 events) | 200x fewer Redis round-trips |
| Ingestion | Redis pipelining | Amortized network latency |
| Buffering | Redis Streams (MAXLEN ~1M) | Bounded memory with backpressure |
| Processing | In-memory threshold lookup | Microsecond evaluation (vs ms for DB query) |
| Processing | 30-second alert cooldown | 60x fewer duplicate alerts |
| Persistence | Npgsql binary COPY | 50x write throughput (50k-100k rows/sec) |
| Persistence | TimescaleDB hypertable (1h chunks) | Parallel I/O, chunk-level compression |
| Persistence | Continuous aggregates | Pre-computed rollups, instant queries |
| Frontend | 100ms render batching | 1000x fewer React re-renders |
| Frontend | EMA throughput smoothing | Stable counter (no burst flicker) |
| Frontend | Zustand selectors | Selective re-renders (chart doesn't update when alert changes) |
| Frontend | D3.js direct SVG manipulation | 60fps chart updates, no virtual DOM overhead |

### Throughput Capacity

| Component | Capacity | Limiting Factor |
|-----------|----------|----------------|
| WebSocket ingestion | 10,000+ concurrent connections | Node.js event loop + memory (~30KB/conn) |
| Redis Stream writes | ~500,000 XADD/sec (pipelined) | Redis single-thread throughput |
| Processing | ~10,000 events/sec per instance | Sequential consumer loop |
| TimescaleDB writes | 50,000–100,000 rows/sec (COPY) | Disk I/O + WAL |
| SignalR broadcast | ~10,000 connected clients | .NET thread pool + memory |

---

## Failure Handling

### Service Failures

| Failure | Impact | Recovery |
|---------|--------|----------|
| **Ingestor crashes** | New sensor connections rejected. Buffer pauses. | Docker restart. Sensors reconnect via WebSocket. |
| **Processor crashes** | Events queue in Redis Stream. Dashboard stalls. | Docker restart. Unacknowledged events re-delivered by consumer group. |
| **Redis crashes** | Ingestion and processing both halt. | Docker restart with data persistence (volume mount). Stream replays from last checkpoint. |
| **TimescaleDB crashes** | Persistence fails. Processor logs errors. | Docker restart. Processor retries batch write on next loop. |
| **Dashboard crashes** | Browser can refresh. No backend impact. | Refresh browser. SignalR auto-reconnects. |

### Data Loss Prevention

1. **Redis Streams persist events** — unlike Pub/Sub, events survive consumer downtime
2. **Consumer group ACK** — events are only acknowledged after successful persistence
3. **Dead Letter Queue** — malformed events are captured, not silently dropped
4. **Graceful shutdown** — ingestor flushes remaining buffer before exit (SIGINT/SIGTERM)
5. **TimescaleDB WAL** — standard PostgreSQL write-ahead log ensures crash recovery

---

## Scalability Model

### Horizontal Scaling

```
                                    Redis Stream
                                   telemetry:inbound
                                        │
                              ┌─────────┼─────────┐
                              ▼         ▼         ▼
                         processor-1  processor-2  processor-3
                         (consumer)   (consumer)   (consumer)
                              │         │         │
                              └─────────┼─────────┘
                                        ▼
                                   TimescaleDB
```

Redis consumer groups automatically distribute events across multiple processor instances. Adding a processor is as simple as:

```yaml
# docker-compose.yml
processor-2:
  build: ./processing-service
  environment:
    PROCESSOR_CONSUMER_NAME: processor-2
    # Same consumer group — events auto-distributed
    PROCESSOR_CONSUMER_GROUP: pulse-processors
```

### Vertical Scaling Knobs

| Knob | Default | Effect of Increase |
|------|---------|-------------------|
| `PROCESSOR_BATCH_SIZE` | 100 | Larger batches = higher throughput, higher latency |
| `PROCESSOR_BLOCK_MS` | 2000 | Longer block = fewer empty polls, slightly higher latency |
| `INGESTOR_MAX_CONNECTIONS` | 10000 | More concurrent sensors (memory scales linearly) |
| Micro-batch interval | 50ms | Larger interval = bigger batches, higher latency |
| Micro-batch threshold | 200 events | Higher threshold = bigger batches, better pipeline efficiency |
| TimescaleDB chunk interval | 1 hour | Larger chunks = fewer files, but slower compression |

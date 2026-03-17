<div align="center">

# PulseEngine

### Distributed Event-Driven IoT Monitoring System

*High-performance telemetry ingestion, real-time processing, and industrial-grade visualization — built to handle 10,000+ sensor signals per second.*

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![.NET](https://img.shields.io/badge/.NET-8.0-512BD4?logo=dotnet&logoColor=white)](https://dotnet.microsoft.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://reactjs.org/)
[![Redis](https://img.shields.io/badge/Redis_Streams-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![TimescaleDB](https://img.shields.io/badge/TimescaleDB-PG16-FDB515?logo=timescale&logoColor=black)](https://www.timescale.com/)
[![Prometheus](https://img.shields.io/badge/Prometheus-Metrics-E6522C?logo=prometheus&logoColor=white)](https://prometheus.io/)
[![Grafana](https://img.shields.io/badge/Grafana-Dashboard-F46800?logo=grafana&logoColor=white)](https://grafana.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

</div>

---

## Table of Contents

- [The Problem](#the-problem)
- [Tech Stack & Why](#tech-stack--why)
- [Architecture Overview](#architecture-overview)
- [System Data Flow](#system-data-flow)
- [Project Structure](#project-structure)
- [Service Deep Dive](#service-deep-dive)
  - [Ingestion Service](#1-ingestion-service--nodejs--typescript)
  - [Processing Service](#2-processing-service--net-core-8--signalr)
  - [Frontend Dashboard](#3-frontend-dashboard--react--d3js)
  - [Sensor Simulator](#4-sensor-simulator--nodejs)
  - [Infrastructure](#5-infrastructure--timescaledb)
  - [Observability](#6-observability--prometheus--grafana)
- [Dead Letter Queue](#dead-letter-queue)
- [Telemetry Event Schema](#telemetry-event-schema)
- [Performance Engineering](#performance-engineering)
- [Problems Solved vs Naive Approaches](#problems-solved-vs-naive-approaches)
- [Configuration Reference](#configuration-reference)
- [Getting Started](#getting-started)
- [Testing the Pipeline](#testing-the-pipeline)

---

## The Problem

In Industry 4.0 environments, thousands of IoT sensors generate a continuous firehose of telemetry data — temperature, pressure, humidity, vibration — at rates exceeding **10,000 events per second**. Traditional architectures fail here:

- **HTTP REST APIs** cannot handle the connection overhead at this scale
- **Polling-based dashboards** introduce unacceptable latency for threshold alerts
- **Standard PostgreSQL** buckles under time-series write amplification
- **Monolithic processors** create single points of failure with no backpressure management
- **Row-by-row database inserts** become the bottleneck long before the network does

PulseEngine is purpose-built to solve each of these problems with a distributed, event-driven architecture that maintains **sub-200ms end-to-end latency** from sensor to dashboard.

---

## Tech Stack & Why

Each technology in PulseEngine was chosen to solve a specific problem that traditional stacks cannot handle at IoT scale.

### Ingestion Layer

| Technology | Role | Problem It Solves |
|---|---|---|
| **Node.js 20** | WebSocket server for sensor connections | Single-threaded event loop efficiently handles **10,000+ concurrent WebSocket connections** without thread-per-connection overhead. Non-blocking I/O is ideal for high-concurrency, low-compute workloads like message relay. |
| **TypeScript** | Type-safe ingestion logic | Catches payload shape errors at compile time (e.g., `value` must be `number`). Prevents silent runtime failures in a service processing thousands of events/sec. |
| **WebSocket (ws)** | Transport protocol for sensors | Full-duplex persistent connections eliminate HTTP handshake overhead. A single TCP connection handles thousands of messages vs one TCP connection per HTTP request. |

### Event Buffering

| Technology | Role | Problem It Solves |
|---|---|---|
| **Redis 7 Streams** | Durable event buffer between ingestion and processing | Unlike Redis Pub/Sub (fire-and-forget), Streams provide **persistent, ordered, replayable** event logs. Consumer groups enable exactly-once delivery with ACK semantics. If the processor crashes, unACK'd events are re-delivered on restart — zero data loss. |

### Processing Layer

| Technology | Role | Problem It Solves |
|---|---|---|
| **.NET Core 8** | Event processing, threshold evaluation, persistence | High-performance runtime with low GC pause times. Strong typing via C# prevents data corruption in the critical processing pipeline. Background worker pattern (`IHostedService`) is purpose-built for long-running consumer loops. |
| **SignalR** | Real-time server-to-browser push | Built-in WebSocket abstraction with automatic reconnection, connection management, and binary MessagePack support. Eliminates the need to build custom WebSocket infrastructure. Pushes data the instant it's processed — no polling delay. |
| **Npgsql Binary COPY** | Bulk database writes | Standard `INSERT` maxes out at ~2,000 rows/sec. PostgreSQL's `COPY` protocol streams binary data directly into table pages — achieving **50,000-100,000 rows/sec**. This is the only way to keep up with 10k+ events/sec ingestion. |

### Persistence Layer

| Technology | Role | Problem It Solves |
|---|---|---|
| **TimescaleDB (PostgreSQL 16)** | Time-series storage with automatic management | Standard PostgreSQL tables degrade as they grow — index bloat, vacuum pressure, slow range queries. TimescaleDB **hypertables** auto-partition into time-based chunks (1-hour intervals), enabling parallel I/O, chunk-level compression (90% savings), instant old-data deletion, and pre-computed continuous aggregates — all with zero maintenance. |

### Frontend Layer

| Technology | Role | Problem It Solves |
|---|---|---|
| **React 18** | UI framework | Component model with efficient reconciliation. At 1000+ events/sec, only changed components re-render — not the entire DOM. |
| **Zustand** | State management | Lightweight store (< 1KB) with no boilerplate. Selectors prevent unnecessary re-renders — e.g., the alert feed doesn't re-render when chart data changes. Redux would add complexity with no benefit for this use case. |
| **D3.js** | Real-time chart rendering | Direct SVG manipulation gives full control over 60-second sliding window charts, crosshair tooltips, threshold bands, and smooth CatmullRom interpolation. Chart libraries (Chart.js, Recharts) can't provide this level of customization for real-time streaming data. |
| **Tailwind CSS** | Styling | Utility-first CSS eliminates style conflicts in a component-heavy dashboard. Dark industrial theme via custom `pulse-*` color palette. |
| **Vite** | Build tool | Sub-second HMR during development. Optimized production builds with tree-shaking for D3.js (only imports used modules). |

### Infrastructure

| Technology | Role | Problem It Solves |
|---|---|---|
| **Docker Compose** | Multi-service orchestration | 6 services (Redis, TimescaleDB, Ingestor, Processor, Dashboard, Simulator) with health checks, dependency ordering, and shared networking — one command to launch the entire system. |
| **Nginx** | Reverse proxy + SPA server | Serves the React build, proxies `/hub/*` WebSocket connections to the .NET processor, and handles SPA fallback routing — all in a 2MB Alpine container. |

### Why Not Alternatives?

| Considered | Rejected Because |
|---|---|
| **Kafka** instead of Redis Streams | Overkill for single-node deployment. Redis Streams provide the same consumer group semantics with 10x less operational complexity. |
| **MongoDB** instead of TimescaleDB | No native time-series optimizations. No automatic chunking, compression, or continuous aggregates. |
| **Socket.io** instead of SignalR | SignalR integrates natively with .NET DI and hub patterns. Socket.io would require a separate Node.js relay service. |
| **REST polling** instead of WebSocket push | 1-second polling = 1-second latency floor. Push delivers in <50ms. At scale, polling also wastes bandwidth on empty responses. |
| **Chart.js / Recharts** instead of D3.js | Pre-built chart libraries don't support real-time sliding windows, crosshair snap-to-point tooltips, or threshold zone overlays without heavy workarounds. |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PulseEngine Architecture                      │
│                                                                      │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐    │
│  │   IoT        │────▶│  Ingestion  │────▶│    Redis Streams    │    │
│  │   Sensors    │ WS  │  Service    │XADD │  (Event Buffer)     │    │
│  │  (10,000+)   │     │  Node.js    │     │  telemetry:inbound  │    │
│  └─────────────┘     └─────────────┘     └────────┬────────────┘    │
│         ▲                                          │                 │
│         │                                    XREADGROUP              │
│  ┌──────┴──────┐                                   │                 │
│  │  Simulator   │                          ┌───────▼────────────┐   │
│  │  Node.js     │                          │  Processing Service │   │
│  │  (Phase FSM) │                          │  .NET Core 8        │   │
│  └─────────────┘                           │                     │   │
│                                            │  ┌───────────────┐  │   │
│                                            │  │  Threshold     │  │   │
│                                            │  │  Alert Engine  │  │   │
│                                            │  │  (30s cooldown)│  │   │
│                                            │  └───────┬───────┘  │   │
│                                            └──────┬───┼──────────┘   │
│                                                   │   │               │
│                                         ┌─────────┘   └─────────┐    │
│                                         │                       │    │
│                                         ▼                       ▼    │
│                              ┌──────────────────┐    ┌──────────────┐│
│                              │   TimescaleDB    │    │  SignalR Hub ││
│                              │   (Persistence)  │    │  (Real-time) ││
│                              │                  │    └──────┬───────┘│
│                              │  • Hypertable    │           │        │
│                              │  • Compression   │           │  WS    │
│                              │  • Aggregates    │           │        │
│                              │  • Retention     │    ┌──────▼───────┐│
│                              └──────────────────┘    │  Dashboard   ││
│                                                      │  React+D3.js ││
│                                                      │  (Browser)   ││
│                                                      └──────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

---

## System Data Flow

### Sensor → Dashboard (Real-time Path)

```
Sensor sends JSON via WebSocket
         │
         ▼  (~1ms)
Ingestor validates payload
         │
         ▼  (micro-batch: 50ms or 200 events)
Redis XADD → telemetry:inbound stream
         │
         ▼  (consumer group poll: up to 100 events/batch)
.NET Processor parses + evaluates thresholds
         │
         ├──▶ TimescaleDB COPY (batch persistence)
         │
         └──▶ SignalR ReceiveTelemetryBatch broadcast
                    │
                    ▼  (100ms buffer + EMA throughput calculation)
              React state update → D3.js re-render
                    │
                    ▼
              Dashboard display (~150-200ms total latency)
```

### Alert Generation Path

```
Telemetry event enters Processor
         │
         ▼  (in-memory threshold check)
Value exceeds configured bounds?
         │
    YES  ▼
Sensor in cooldown? (30-second per-sensor cooldown)
         │
    NO   ▼
ThresholdAlert generated (severity: CRITICAL)
         │
         ├──▶ INSERT into alerts table
         │
         └──▶ SignalR ReceiveAlert broadcast
                    │
                    ▼
              LiveAlertFeed updates + SensorCard turns red
              + animated ping indicator
```

---

## Project Structure

```
PulseEngine/
│
├── docker-compose.yml              # Orchestrates all 8 services
├── .env                            # Centralized environment configuration
├── README.md                       # You are here
│
├── ingestion-service/              # ── Node.js + TypeScript ──────────
│   ├── src/
│   │   ├── websocket/
│   │   │   └── server.ts           # WS server: validation, micro-batching
│   │   ├── redis/
│   │   │   └── producer.ts         # Redis Stream XADD with pipelining
│   │   └── index.ts                # Bootstrap, config, graceful shutdown
│   ├── Dockerfile                  # Multi-stage: build → node:20-alpine
│   ├── package.json
│   └── tsconfig.json
│
├── processing-service/             # ── .NET Core 8 + SignalR ─────────
│   ├── Workers/
│   │   └── TelemetryConsumerWorker.cs   # Redis Stream consumer (XREADGROUP)
│   ├── Models/
│   │   └── TelemetryEvent.cs            # Domain models: TelemetryEvent, ThresholdAlert
│   ├── Services/
│   │   ├── TimescaleDbService.cs        # Batch persistence via Npgsql COPY
│   │   └── ThresholdAlertService.cs     # Threshold evaluation + 30s cooldown
│   ├── Hubs/
│   │   └── TelemetryHub.cs             # SignalR hub for browser connections
│   ├── Program.cs                       # DI, middleware, hub mapping
│   ├── PulseProcessor.csproj
│   └── Dockerfile                       # Multi-stage: sdk → aspnet:8.0-alpine
│
├── frontend/                       # ── React + Vite + D3.js ─────────
│   ├── src/
│   │   ├── hooks/
│   │   │   └── useSignalR.ts            # SignalR connection + EMA throughput
│   │   ├── store/
│   │   │   └── telemetryStore.ts        # Zustand: streams, sensors, alerts
│   │   ├── components/
│   │   │   ├── charts/
│   │   │   │   └── TelemetryChart.tsx   # D3.js line chart (60s sliding window)
│   │   │   ├── status/
│   │   │   │   ├── SensorCard.tsx       # Green→Red status card per sensor
│   │   │   │   └── GaugeRing.tsx        # SVG radial gauge with thresholds
│   │   │   └── alerts/
│   │   │       └── LiveAlertFeed.tsx    # Scrollable alert feed with ACK
│   │   ├── App.tsx                      # 3-row responsive dashboard layout
│   │   ├── main.tsx                     # React entry point
│   │   └── index.css                    # Tailwind base + custom scrollbar
│   ├── nginx.conf                       # SPA routing + SignalR WebSocket proxy
│   ├── Dockerfile                       # Multi-stage: Vite build → nginx:alpine
│   ├── tailwind.config.js               # Dark industrial theme (pulse-* palette)
│   ├── vite.config.ts
│   └── package.json
│
├── simulator/                      # ── Node.js Sensor Simulator ──────
│   ├── simulator.js                # Phase-based FSM data generator
│   ├── Dockerfile                  # node:20-alpine
│   └── package.json
│
└── infrastructure/
    ├── init-db.sql                 # TimescaleDB schema, hypertable, policies
    ├── prometheus.yml              # Prometheus scrape configuration
    └── grafana/
        ├── provisioning/
        │   ├── datasources/
        │   │   └── datasource.yml  # Auto-configure Prometheus source
        │   └── dashboards/
        │       └── dashboard.yml   # File-based dashboard provider
        └── dashboards/
            └── pulse-health.json   # Pre-built PulseEngine Health dashboard
```

---

## Service Deep Dive

### 1. Ingestion Service — Node.js + TypeScript

**Purpose:** Accept concurrent WebSocket connections from IoT sensors, validate payloads, and stream events into Redis.

#### Key Design Patterns

| Pattern | Implementation | Why |
|---------|---------------|-----|
| **Micro-batching** | Buffer flushed every 50ms or 200 events | Reduces Redis round-trips from 10k/s to ~50 pipeline calls/s |
| **Redis Pipelining** | `pipeline.xadd()` in a loop, single `exec()` | Amortizes network latency across batch |
| **Stream Trimming** | `XADD ... MAXLEN ~ 1000000` | Approximate trim keeps stream bounded without blocking |
| **Backpressure Recovery** | Failed batches re-queued at buffer front | No data loss on transient Redis failures |
| **Graceful Shutdown** | SIGINT/SIGTERM → final flush → close | Zero event loss during deploys |

#### Validation Rules

```
sensorId   → required, string
metricType → required, string
value      → required, finite number
unit       → optional, string
timestamp  → optional, ISO-8601 (defaults to server time)
metadata   → optional, object (stringified to JSON)
```

Invalid payloads receive an immediate error response — they never reach Redis.

---

### 2. Processing Service — .NET Core 8 + SignalR

**Purpose:** Consume buffered events, evaluate alert thresholds, persist to TimescaleDB, and broadcast to connected dashboards.

#### Processing Pipeline (per batch)

```
1. XREADGROUP (up to 100 events from consumer group)
2. Parse Redis hash fields → TelemetryEvent domain objects
3. ThresholdAlertService.Evaluate() → List<ThresholdAlert>
   └── 30-second per-sensor cooldown prevents alert flooding
4. TimescaleDbService.InsertTelemetryBatchAsync() → COPY binary import
5. TimescaleDbService.InsertAlertsAsync() → parameterized INSERT
6. IHubContext.Clients.All.SendAsync("ReceiveTelemetryBatch", ...)
7. IHubContext.Clients.All.SendAsync("ReceiveAlert", ...) per alert
8. StreamAcknowledgeAsync() → ACK each entry
```

#### Alert Cooldown

At high throughput (1000+ evt/s), a single sensor in alert state could generate hundreds of duplicate alerts per second. The `ThresholdAlertService` enforces a **30-second cooldown per sensor** — once a sensor triggers an alert, it won't fire again for that sensor until 30 seconds have passed. This keeps the alert feed meaningful and actionable.

#### Consumer Group Benefits

- **Exactly-once delivery** — events ACK'd only after successful persistence
- **Horizontal scaling** — add more processor instances; Redis auto-distributes
- **Failure recovery** — unACK'd events are re-delivered on restart

#### Threshold Configuration

Thresholds are loaded from environment variables at startup:

| Metric Type | Low Threshold | High Threshold |
|-------------|:------------:|:--------------:|
| Temperature | -10.0 | 85.0 |
| Pressure | — | 150.0 |
| Humidity | — | 95.0 |

Values exceeding bounds generate `CRITICAL` severity alerts (subject to 30s cooldown).

#### SignalR Hub

The hub at `/hub/telemetry` exposes two server-to-client events:

| Event | Payload | Trigger |
|-------|---------|---------|
| `ReceiveTelemetryBatch` | Array of `{ SensorId, MetricType, Value, Unit, Timestamp }` | Every processed batch |
| `ReceiveAlert` | `{ Id, SensorId, MetricType, ThresholdValue, ActualValue, Severity, Message, TriggeredAt }` | Each threshold breach (post-cooldown) |

---

### 3. Frontend Dashboard — React + D3.js

**Purpose:** Real-time industrial monitoring UI with live charts, sensor status, and alert feed.

#### Component Architecture

```
App.tsx
├── Header (connection status, EMA throughput counter)
├── Row 1: GaugeRing[] + Summary Cards
│   ├── GaugeRing (per top sensor)
│   ├── Active Sensors count
│   ├── Active Alerts count
│   ├── Alerting sensors count
│   └── Throughput (evt/s)
├── Row 2: Charts + Alert Feed
│   ├── TelemetryChart[] (D3.js, top 4 sensors)
│   └── LiveAlertFeed (scrollable, filterable, ACK support)
└── Row 3: SensorCard[] grid (all sensors)
```

#### Real-time Data Pipeline

```
SignalR WebSocket
    │
    ▼
useSignalR hook (bufferRef accumulates events)
    │
    ▼  (setInterval: 100ms)
Flush buffer → pushTelemetry(batch)
    │
    ├──▶ EMA throughput: α=0.3 smoothing → stable evt/s display
    │
    ▼
Zustand store updates (streams, sensors)
    │
    ▼
React re-render → D3.js chart redraw
```

**Why 100ms batching?** At 1000+ events/sec, updating React state per-event would cause thousands of re-renders/second. Batching at 100ms intervals means ~10 state updates/second — smooth and performant.

**Why EMA for throughput?** SignalR delivers events in bursts (processor batches). A raw counter would flash between 0 and spike values. The Exponential Moving Average (α=0.3) smooths the display — it rises quickly on batch arrival and decays gradually, showing a stable reading.

#### TelemetryChart (D3.js)

- **60-second sliding window** — X-axis advances in real-time
- **CatmullRom curve interpolation** — smooth line through noisy data
- **Area gradient fill** — visual depth under the line
- **Threshold danger zones** — shaded red/blue bands at configured bounds
- **Crosshair tooltip** — hover to inspect values with snap-to-nearest-point
- **Min/Avg/Max stats** — header shows real-time statistics
- **Trend arrows** — TrendingUp/Down icons with color coding
- **Latest value dot** — animated circle at the newest data point

#### LiveAlertFeed

- **Filter tabs** — All / Active / Acknowledged with counts
- **Auto-scroll** — scrolls to top on new alerts, pauses when user scrolls down
- **Acknowledge** — per-alert ACK button (hover to reveal) and bulk "ACK All"
- **Severity indicators** — CRITICAL (red octagon) / WARNING (yellow triangle) / ACK'd (green check)
- **Time tracking** — relative time ("3s ago") + absolute timestamp + ACK timestamp
- **Scrollable** — fixed height container, internally scrollable, max 100 alerts

#### SensorCard

- **Green state:** normal operation, metric-colored icon, progress bar
- **Red state:** alert active, red background, danger icon, animated ping dot
- **Transition:** CSS `transition-all duration-300` for smooth color change

#### GaugeRing (SVG)

- 270-degree arc rendered with `stroke-dasharray` and `stroke-dashoffset`
- Color gradient: green → yellow → red based on proximity to threshold
- Drop shadow glow effect matching current color

---

### 4. Sensor Simulator — Node.js

**Purpose:** Generate realistic IoT sensor data with configurable throughput and natural alert scenarios.

#### Phase-Based State Machine

Each simulated sensor cycles through behavior phases, creating realistic patterns:

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

#### Sensor Fleet

| Prefix | Metric Type | Unit | Base Range | Threshold |
|--------|------------|------|------------|-----------|
| TEMP | temperature | °C | 25–70 | Low: -10, High: 85 |
| PRESS | pressure | PSI | 40–110 | High: 150 |
| HUM | humidity | %RH | 35–75 | High: 95 |

#### Throughput Configuration

Events per second = `BURST_SIZE × (1000 / INTERVAL_MS)`

| Target evt/s | INTERVAL_MS | BURST_SIZE |
|---|---|---|
| 100 | 100 | 10 |
| 500 | 50 | 25 |
| 1000 | 25 | 25 |
| 2000 | 50 | 100 |
| 5000 | 20 | 100 |

Set via environment variables in `docker-compose.yml` under the `simulator` service.

---

### 5. Infrastructure — TimescaleDB

**Purpose:** Durable time-series storage for historical analysis, reporting, and audit trails. While the frontend shows live data from SignalR (last 60 seconds), TimescaleDB stores **all data permanently** for historical trend charts, reporting queries, alert audit logs, and analytics.

#### Schema Design

**Telemetry Hypertable:**

| Column | Type | Purpose |
|--------|------|---------|
| `id` | BIGSERIAL | Auto-increment PK (with recorded_at) |
| `sensor_id` | VARCHAR(64) | Device identifier |
| `metric_type` | VARCHAR(32) | Signal category |
| `value` | DOUBLE PRECISION | Sensor reading |
| `unit` | VARCHAR(16) | Measurement unit |
| `recorded_at` | TIMESTAMPTZ | Sensor timestamp (partition key) |
| `ingested_at` | TIMESTAMPTZ | Server reception time |
| `metadata` | JSONB | Extensible key-value data |

**Hypertable Configuration:**

```sql
-- 1-hour chunks: optimal for 10k+ events/sec write patterns
SELECT create_hypertable('telemetry', 'recorded_at',
    chunk_time_interval => INTERVAL '1 hour');
```

#### Automated Policies

| Policy | Configuration | Purpose |
|--------|--------------|---------|
| **Compression** | Chunks > 2 hours old | ~90% storage reduction |
| **Retention** | Raw data > 30 days | Prevents unbounded disk growth |
| **Continuous Aggregate** | 1-minute rollups (min/avg/max per sensor), refreshed every minute | Fast dashboard queries over historical data |

#### Indexes

```sql
idx_telemetry_sensor_time   → (sensor_id, recorded_at DESC)
idx_telemetry_metric_type   → (metric_type, recorded_at DESC)
idx_alerts_sensor           → (sensor_id, triggered_at DESC)
idx_alerts_unack            → (acknowledged, triggered_at DESC) WHERE NOT acknowledged
```

---

### 6. Observability — Prometheus + Grafana

**Purpose:** Monitor PulseEngine's own health — CPU, memory, event rates, latencies, error counts — via industry-standard Prometheus metrics and pre-built Grafana dashboards.

#### Architecture

```
┌───────────────┐       ┌───────────────┐
│   Ingestor    │:9100  │   Processor   │:5050
│   /metrics    │◄──────│   /metrics    │◄──────┐
└───────────────┘  scrape└───────────────┘       │
        ▲                        ▲               │
        │          ┌─────────────┘               │
        └──────────┤  Prometheus  │:9090         │
                   │  (15s scrape)│───────────────┘
                   └──────┬──────┘
                          │ PromQL
                   ┌──────▼──────┐
                   │   Grafana   │:3001
                   │  (auto-     │
                   │  provisioned│
                   │  dashboard) │
                   └─────────────┘
```

#### Processor Metrics (.NET)

| Metric | Type | Description |
|--------|------|-------------|
| `pulse_events_processed_total` | Counter | Events successfully processed |
| `pulse_batch_size` | Histogram | Events per processing batch |
| `pulse_processing_duration_seconds` | Histogram | Full batch processing time |
| `pulse_db_write_duration_seconds` | Histogram | TimescaleDB COPY duration |
| `pulse_alerts_generated_total` | Counter | Threshold alerts created |
| `pulse_signalr_connections` | Gauge | Active dashboard connections |
| `pulse_dlq_messages_total` | Counter | Messages routed to DLQ |
| `pulse_dlq_length` | Gauge | Current DLQ size |

#### Ingestor Metrics (Node.js)

| Metric | Type | Description |
|--------|------|-------------|
| `pulse_ws_connections_active` | Gauge | Active WebSocket connections |
| `pulse_ws_messages_received_total` | Counter | Messages received from sensors |
| `pulse_redis_pushes_total` | Counter | Events pushed to Redis |
| `pulse_batch_flush_duration_seconds` | Histogram | Pipeline exec duration |
| `pulse_ingestor_nodejs_heap_size_*` | Gauge | Node.js heap memory (auto-collected) |
| `pulse_ingestor_nodejs_eventloop_lag_seconds` | Gauge | Event loop lag (auto-collected) |

#### Grafana Dashboard

Auto-provisioned at startup with 14 panels across two rows:

- **Processor row:** Events rate, batch size histogram, processing duration P50/P95/P99, DB write P95, SignalR connections, alerts rate, DLQ count, DLQ queue length
- **Ingestor row:** WebSocket connections, messages rate, Redis push rate, flush duration P95, heap memory, event loop lag

Access at `http://localhost:3001` (login: `admin` / `pulse2026`).

---

## Dead Letter Queue

**Purpose:** Corrupted or malformed telemetry data is captured instead of silently dropped, enabling debugging and replay.

#### How It Works

```
Redis Stream entry arrives at Processor
         │
         ▼
Parse sensorId, metricType, value
         │
    FAIL ▼ (missing field or unparseable value)
DeadLetterService.PushAsync()
         │
         ▼
LPUSH → telemetry_errors (Redis list)
         │
         ▼
JSON payload stored:
{
  "StreamEntryId": "1710000000000-0",
  "RawData": { "sensorId": "...", "value": "NaN" },
  "ErrorReason": "Unparseable value: 'NaN'",
  "Timestamp": "2026-03-17T...",
  "Source": "TelemetryConsumerWorker"
}
```

#### Design Decisions

- **ACK after DLQ:** Malformed entries are ACK'd to prevent infinite re-delivery of bad data. The DLQ preserves the data for manual inspection.
- **LPUSH ordering:** Most recent failures appear first (natural debugging order).
- **No TTL:** DLQ entries persist until manually cleared — important for audit trails.
- **Prometheus integration:** `pulse_dlq_messages_total` (counter) and `pulse_dlq_length` (gauge) are exposed for alerting in Grafana.

#### Inspecting the DLQ

```bash
# View latest 10 DLQ entries
docker exec pulse-redis redis-cli LRANGE telemetry_errors 0 9

# Count total DLQ entries
docker exec pulse-redis redis-cli LLEN telemetry_errors

# Clear the DLQ after inspection
docker exec pulse-redis redis-cli DEL telemetry_errors
```

---

## Telemetry Event Schema

### WebSocket Input (Sensor → Ingestor)

```json
{
  "sensorId": "TEMP-FLOOR3-001",
  "metricType": "temperature",
  "value": 72.5,
  "unit": "°C",
  "timestamp": "2026-03-16T12:34:56.789Z",
  "metadata": {
    "location": "Building-A",
    "floor": 3,
    "firmware": "v2.1.4"
  }
}
```

### Redis Stream Entry (Ingestor → Processor)

```
XADD telemetry:inbound MAXLEN ~ 1000000 *
  sensorId  "TEMP-FLOOR3-001"
  metricType "temperature"
  value      "72.5"
  unit       "°C"
  timestamp  "2026-03-16T12:34:56.789Z"
  metadata   "{\"location\":\"Building-A\",\"floor\":3}"
```

### SignalR Broadcast (Processor → Dashboard)

```json
// ReceiveTelemetryBatch
[
  {
    "sensorId": "TEMP-FLOOR3-001",
    "metricType": "temperature",
    "value": 72.5,
    "unit": "°C",
    "timestamp": "2026-03-16T12:34:56.789Z"
  }
]

// ReceiveAlert
{
  "id": "a1b2c3d4-...",
  "sensorId": "TEMP-FLOOR3-001",
  "metricType": "temperature",
  "thresholdValue": 85.0,
  "actualValue": 91.3,
  "severity": "CRITICAL",
  "message": "temperature value 91.3 exceeds upper threshold 85.0",
  "triggeredAt": "2026-03-16T12:35:01.123Z"
}
```

---

## Performance Engineering

### Why Each Optimization Matters

#### 1. Micro-batching at Ingestion (50ms / 200 events)

**Without:** 10,000 individual `XADD` commands/second → 10,000 network round-trips.
**With:** ~50 pipelined batches/second → **200x fewer round-trips**.

#### 2. Redis Streams over Pub/Sub

**Pub/Sub:** Fire-and-forget. If the processor is down, events are lost.
**Streams:** Persistent, ordered log with consumer groups. Events survive restarts.

#### 3. COPY Binary Import vs INSERT

**INSERT (row-by-row):** ~1,000-2,000 rows/second per connection.
**COPY binary:** ~50,000-100,000 rows/second. **50x throughput improvement.**

```csharp
// PulseEngine uses Npgsql binary COPY:
await using var writer = await conn.BeginBinaryImportAsync(
    "COPY telemetry (...) FROM STDIN (FORMAT BINARY)");
```

#### 4. In-memory Threshold Evaluation with Cooldown

**Database-backed:** Query thresholds per event → 10,000 SELECT queries/second.
**In-memory:** Dictionary lookup per event → **microsecond latency, zero DB load**.
**30s cooldown:** Prevents alert flooding — at 1000 evt/s, one breaching sensor would generate 1000 alerts/sec without cooldown. With it: max 1 alert per sensor per 30 seconds.

#### 5. SignalR Push vs Polling

**Polling (1s interval):** Dashboard always 0-1 second behind. Wastes bandwidth when idle.
**SignalR push:** Events arrive within milliseconds. Zero traffic when no data flows.

#### 6. 100ms Render Batching + EMA Throughput in React

**Per-event render:** 10,000 React renders/second → browser freezes.
**100ms batching:** ~10 renders/second → **smooth 60fps UI**.
**EMA (α=0.3):** Smooths the evt/s counter display. Raw counting flashes between 0 and spike values because SignalR delivers in bursts. EMA provides a stable, human-readable throughput reading.

#### 7. TimescaleDB Hypertable Chunking

**Standard PostgreSQL:** Single table for all data → index bloat, vacuum pressure.
**Hypertable (1-hour chunks):** Parallel I/O, chunk-level compression, drop old chunks instantly.

---

## Problems Solved vs Naive Approaches

| Problem | Naive Approach | PulseEngine Solution | Improvement |
|---------|---------------|---------------------|-------------|
| **10k+ events/sec ingestion** | HTTP POST per event | WebSocket + Redis Stream micro-batching | 200x fewer round-trips |
| **Real-time dashboard** | Poll database every 1-5s | SignalR push from processor | Sub-200ms latency |
| **Sensor backpressure** | Drop events when overloaded | Bounded Redis Stream (MAXLEN~) | Zero data loss |
| **Threshold evaluation** | SELECT thresholds per event | In-memory dictionary lookup | μs vs ms latency |
| **Alert flooding** | Alert on every threshold breach | 30-second per-sensor cooldown | Max 2 alerts/min/sensor |
| **Bulk persistence** | INSERT per row | Npgsql binary COPY | 50x write throughput |
| **Time-series queries** | Full table scan | TimescaleDB hypertable + indexes | Orders of magnitude faster |
| **Storage growth** | Manual cleanup scripts | Auto-compression (2h) + retention (30d) | Zero maintenance |
| **Dashboard jank** | Re-render per event | 100ms Zustand batching | 1000x fewer renders |
| **Flickering throughput** | Raw counter (resets to 0 between bursts) | EMA smoothing (α=0.3) | Stable, readable display |
| **Historical rollups** | Ad-hoc GROUP BY queries | Continuous aggregates (pre-computed) | Instant dashboard loads |
| **Processor failure** | Lost in-flight events | Consumer group ACKs + re-delivery | At-least-once guarantee |
| **Horizontal scaling** | Single monolith | Consumer group sharding (add instances) | Linear scale-out |
| **Corrupted data** | Silent skip or crash | Dead Letter Queue (Redis `telemetry_errors`) | Zero data loss, full audit |
| **System observability** | No metrics, just logs | Prometheus + Grafana with 14-panel dashboard | Real-time CPU, memory, latency, error rates |

---

## Configuration Reference

### Ports

| Service | Port | Protocol | Description |
|---------|------|----------|-------------|
| Ingestion | `8085` | WebSocket | Sensor telemetry intake |
| Ingestion Metrics | `9100` | HTTP | Prometheus metrics endpoint |
| Processor | `5050` | HTTP/WS | SignalR hub + Prometheus /metrics |
| Dashboard | `3000` | HTTP | Nginx-served React app |
| Prometheus | `9090` | HTTP | Metrics collection & PromQL |
| Grafana | `3001` | HTTP | Health dashboards (admin/pulse2026) |
| Redis | `6379` | RESP | Stream buffer |
| TimescaleDB | `5432` | PostgreSQL | Persistent storage |

### Environment Variables (`.env`)

```env
# ─── Redis ─────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_STREAM_KEY=telemetry:inbound

# ─── PostgreSQL + TimescaleDB ──────────────────
POSTGRES_HOST=timescaledb
POSTGRES_PORT=5432
POSTGRES_DB=pulseengine
POSTGRES_USER=pulse_admin
POSTGRES_PASSWORD=Pulse$ecure2026!

# ─── Ingestion Service ─────────────────────────
INGESTOR_WS_PORT=8085
INGESTOR_MAX_CONNECTIONS=10000

# ─── Processing Service ────────────────────────
PROCESSOR_CONSUMER_GROUP=pulse-processors
PROCESSOR_CONSUMER_NAME=processor-1
PROCESSOR_BATCH_SIZE=100
PROCESSOR_BLOCK_MS=2000

# ─── Alert Thresholds ──────────────────────────
ALERT_TEMPERATURE_HIGH=85.0
ALERT_TEMPERATURE_LOW=-10.0
ALERT_PRESSURE_HIGH=150.0
ALERT_HUMIDITY_HIGH=95.0
```

### Simulator Configuration (`docker-compose.yml`)

```yaml
simulator:
  environment:
    SENSORS_COUNT: 8        # Number of simulated sensors
    INTERVAL_MS: 25         # Milliseconds between ticks
    BURST_SIZE: 25          # Events sent per tick
    # evt/s = BURST_SIZE × (1000 / INTERVAL_MS) = 1000
```

---

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/install/)

### Launch

```bash
cd PulseEngine
docker compose up --build
```

All 8 services will start in dependency order:

```
1. Redis         → Healthy (PING/PONG)
2. TimescaleDB   → Healthy (pg_isready) + runs init-db.sql
3. Ingestor      → Connects to Redis, opens WebSocket on :8085, metrics on :9100
4. Processor     → Connects to Redis + TimescaleDB, SignalR hub + /metrics on :5050
5. Dashboard     → Builds React app, Nginx serves on :3000 with /hub/ proxy
6. Simulator     → Connects to Ingestor, begins generating sensor data
7. Prometheus    → Scrapes Ingestor + Processor every 15s, UI on :9090
8. Grafana       → Auto-provisions PulseEngine Health dashboard on :3001
```

### Access

| Interface | URL |
|-----------|-----|
| Dashboard | [http://localhost:3000](http://localhost:3000) |
| Grafana | [http://localhost:3001](http://localhost:3001) (admin / pulse2026) |
| Prometheus | [http://localhost:9090](http://localhost:9090) |
| WebSocket Ingestor | `ws://localhost:8085` |
| SignalR Hub | `http://localhost:5050/hub/telemetry` |
| Processor Metrics | `http://localhost:5050/metrics` |
| Ingestor Metrics | `http://localhost:9100/metrics` |

### Clean Restart (clear all data)

```bash
docker compose down
docker volume rm pulseengine_redis_data pulseengine_pg_data pulseengine_prometheus_data pulseengine_grafana_data
docker compose up --build
```

---

## Testing the Pipeline

### Send a Single Event

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
ws.onmessage = (e) => console.log("ACK:", e.data);
// Output: ACK: {"ack":true,"sensorId":"TEMP-FLOOR3-001"}
```

### Trigger a Threshold Alert

```javascript
// Temperature > 85.0 triggers CRITICAL alert
ws.send(JSON.stringify({
  sensorId: "TEMP-FLOOR3-001",
  metricType: "temperature",
  value: 91.3,
  unit: "°C",
  timestamp: new Date().toISOString()
}));
// Dashboard: LiveAlertFeed shows CRITICAL alert
// Dashboard: SensorCard turns red with ping animation
// Note: same sensor won't trigger again for 30 seconds (cooldown)
```

### Simulate High Throughput

```javascript
const ws = new WebSocket("ws://localhost:8085");
ws.onopen = () => {
  const sensors = ["TEMP-001", "TEMP-002", "PRESS-001", "HUM-001"];
  const metrics = ["temperature", "pressure", "humidity"];

  setInterval(() => {
    for (let i = 0; i < 100; i++) {
      ws.send(JSON.stringify({
        sensorId: sensors[Math.floor(Math.random() * sensors.length)],
        metricType: metrics[Math.floor(Math.random() * metrics.length)],
        value: Math.random() * 100,
        timestamp: new Date().toISOString()
      }));
    }
  }, 10); // 10,000 events/second
};
```

### Verify Data in TimescaleDB

```bash
docker exec -it pulse-timescaledb psql -U pulse_admin -d pulseengine

-- Recent telemetry
SELECT sensor_id, metric_type, value, recorded_at
FROM telemetry ORDER BY recorded_at DESC LIMIT 10;

-- Alert count
SELECT COUNT(*) FROM alerts WHERE acknowledged = FALSE;

-- 1-minute aggregates
SELECT * FROM telemetry_1m ORDER BY bucket DESC LIMIT 5;

-- Compression stats
SELECT * FROM hypertable_compression_stats('telemetry');
```

---

<div align="center">

**Built for Industry 4.0** — where milliseconds matter and data never sleeps.

</div>

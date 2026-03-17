# Development Guide

## Table of Contents

- [Project Structure](#project-structure)
- [Local Development Setup](#local-development-setup)
- [Service Development](#service-development)
  - [Ingestion Service (Node.js)](#ingestion-service-nodejs)
  - [Processing Service (.NET)](#processing-service-net)
  - [Frontend Dashboard (React)](#frontend-dashboard-react)
  - [Simulator (Node.js)](#simulator-nodejs)
- [Docker Development](#docker-development)
- [Code Architecture](#code-architecture)
- [Coding Conventions](#coding-conventions)
- [Testing](#testing)
- [Adding New Features](#adding-new-features)

---

## Project Structure

```
PulseEngine/
├── docker-compose.yml              # 8-service orchestration
├── .env                            # Centralized environment configuration
├── README.md                       # Project overview
├── docs/                           # Documentation (you are here)
│
├── ingestion-service/              # Node.js 20 + TypeScript
│   ├── src/
│   │   ├── index.ts                # Entry point: server bootstrap, metrics, shutdown
│   │   ├── websocket/
│   │   │   └── server.ts           # WS server: validation, micro-batching
│   │   └── redis/
│   │       └── producer.ts         # Redis Stream XADD with pipelining
│   ├── Dockerfile                  # Multi-stage: build → node:20-alpine
│   ├── package.json
│   └── tsconfig.json
│
├── processing-service/             # .NET Core 8 + SignalR
│   ├── Program.cs                  # DI setup, middleware, hub mapping
│   ├── Workers/
│   │   └── TelemetryConsumerWorker.cs  # Redis consumer loop (BackgroundService)
│   ├── Models/
│   │   └── TelemetryEvent.cs       # Domain models: TelemetryEvent, ThresholdAlert
│   ├── Services/
│   │   ├── TimescaleDbService.cs   # Batch persistence (Npgsql Binary COPY)
│   │   ├── ThresholdAlertService.cs # Threshold evaluation + 30s cooldown
│   │   └── DeadLetterService.cs    # DLQ management (Redis list)
│   ├── Hubs/
│   │   └── TelemetryHub.cs        # SignalR hub for real-time push
│   ├── PulseProcessor.csproj      # .NET project file
│   └── Dockerfile                  # Multi-stage: sdk → aspnet:8.0-alpine
│
├── frontend/                       # React 18 + Vite + D3.js
│   ├── src/
│   │   ├── App.tsx                 # Main dashboard layout (3 rows)
│   │   ├── main.tsx                # React entry point
│   │   ├── index.css               # Tailwind base + custom scrollbar
│   │   ├── hooks/
│   │   │   └── useSignalR.ts       # SignalR connection + EMA throughput
│   │   ├── store/
│   │   │   └── telemetryStore.ts   # Zustand: streams, sensors, alerts
│   │   └── components/
│   │       ├── charts/
│   │       │   └── TelemetryChart.tsx   # D3.js line chart (60s window)
│   │       ├── status/
│   │       │   ├── SensorCard.tsx       # Green/Red status cards
│   │       │   └── GaugeRing.tsx        # SVG radial gauge
│   │       └── alerts/
│   │           └── LiveAlertFeed.tsx    # Scrollable alert feed with ACK
│   ├── nginx.conf                  # SPA routing + SignalR proxy
│   ├── Dockerfile                  # Multi-stage: Vite build → nginx:alpine
│   ├── tailwind.config.js          # Dark industrial theme
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── simulator/                      # Sensor data generator
│   ├── simulator.js                # Phase-based FSM
│   ├── Dockerfile
│   └── package.json
│
└── infrastructure/
    ├── init-db.sql                 # TimescaleDB schema + policies
    ├── prometheus.yml              # Scrape configuration
    └── grafana/
        ├── provisioning/
        │   ├── datasources/
        │   │   └── datasource.yml  # Prometheus data source
        │   └── dashboards/
        │       └── dashboard.yml   # Dashboard provider config
        └── dashboards/
            └── pulse-health.json   # Pre-built health dashboard
```

---

## Local Development Setup

### Option 1: Full Docker Stack (Recommended)

The simplest way to develop is to run the full stack and rebuild the service you're modifying:

```bash
# Start everything
docker compose up --build -d

# After making changes to a service, rebuild just that service
docker compose up --build -d processor

# Watch logs for the service you're developing
docker compose logs -f processor
```

### Option 2: Hybrid (Infrastructure in Docker, Services Local)

Run infrastructure services in Docker and your service locally for faster iteration:

```bash
# Start only infrastructure
docker compose up -d redis timescaledb

# Then run your service locally (see per-service instructions below)
```

### Required Tools for Local Development

| Tool | Version | Required For |
|------|---------|-------------|
| Node.js | 20+ | Ingestion service, simulator, frontend |
| npm | 9+ | Node.js package management |
| .NET SDK | 8.0+ | Processing service |
| Docker | 20.10+ | Infrastructure services + full stack |
| Docker Compose | 2.0+ | Multi-service orchestration |

---

## Service Development

### Ingestion Service (Node.js)

**Location:** `ingestion-service/`

```bash
# Install dependencies
cd ingestion-service
npm install

# Set environment variables
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_STREAM_KEY=telemetry:inbound
export INGESTOR_WS_PORT=8085

# Build TypeScript
npm run build

# Run (ensure Redis is running on localhost:6379)
node dist/index.js
```

**Key files:**

| File | Purpose |
|------|---------|
| `src/index.ts` | Bootstrap: creates WS server, Redis producer, metrics server, graceful shutdown |
| `src/websocket/server.ts` | WebSocket handler: validates payloads, buffers events, triggers flushes |
| `src/redis/producer.ts` | Redis client: pipelined XADD with MAXLEN trim |

**Development notes:**
- Micro-batch settings are in `server.ts`: `FLUSH_INTERVAL_MS = 50`, `FLUSH_THRESHOLD = 200`
- Prometheus metrics are exposed on a separate HTTP server (port 9100)
- The `prom-client` library auto-collects Node.js runtime metrics

### Processing Service (.NET)

**Location:** `processing-service/`

```bash
# Restore dependencies
cd processing-service
dotnet restore

# Set environment variables
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_STREAM_KEY=telemetry:inbound
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=pulseengine
export POSTGRES_USER=pulse_admin
export POSTGRES_PASSWORD='Pulse$ecure2026!'
export PROCESSOR_CONSUMER_GROUP=pulse-processors
export PROCESSOR_CONSUMER_NAME=processor-1
export PROCESSOR_BATCH_SIZE=100
export PROCESSOR_BLOCK_MS=2000
export ALERT_TEMPERATURE_HIGH=85.0
export ALERT_TEMPERATURE_LOW=-10.0
export ALERT_PRESSURE_HIGH=150.0
export ALERT_HUMIDITY_HIGH=95.0

# Run (ensure Redis + TimescaleDB are running)
dotnet run
```

**Key files:**

| File | Purpose |
|------|---------|
| `Program.cs` | DI configuration, SignalR setup, Prometheus middleware |
| `Workers/TelemetryConsumerWorker.cs` | Main processing loop: Redis → parse → evaluate → persist → broadcast |
| `Services/TimescaleDbService.cs` | Database operations: binary COPY for telemetry, INSERT for alerts |
| `Services/ThresholdAlertService.cs` | Threshold evaluation with per-sensor cooldown tracking |
| `Services/DeadLetterService.cs` | DLQ management: LPUSH malformed entries to Redis list |
| `Models/TelemetryEvent.cs` | Domain models: TelemetryEvent, ThresholdAlert |
| `Hubs/TelemetryHub.cs` | SignalR hub (minimal — used for connection management) |

**Development notes:**
- The consumer worker uses `IHostedService` — it starts automatically with the app
- Consumer group is auto-created if missing (uses `StreamCreateConsumerGroup` with `StreamPosition.NewMessages`)
- Threshold config is loaded from environment variables in `ThresholdAlertService`
- Prometheus metrics use `prometheus-net.AspNetCore` middleware

### Frontend Dashboard (React)

**Location:** `frontend/`

```bash
# Install dependencies
cd frontend
npm install

# Start Vite dev server (with HMR)
npm run dev
# → http://localhost:5173

# Build for production
npm run build
# → dist/ directory (served by Nginx in Docker)
```

**Key files:**

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main dashboard layout: 3-row grid with all components |
| `src/hooks/useSignalR.ts` | SignalR connection, event buffering, EMA throughput calculation |
| `src/store/telemetryStore.ts` | Zustand store: streams (60s window), sensors, alerts (max 100) |
| `src/components/charts/TelemetryChart.tsx` | D3.js real-time line chart with crosshair tooltip |
| `src/components/alerts/LiveAlertFeed.tsx` | Scrollable alert feed with filter tabs and ACK |
| `src/components/status/SensorCard.tsx` | Per-sensor status card (green/red state) |
| `src/components/status/GaugeRing.tsx` | SVG radial gauge with color gradient |

**Development notes:**
- The Vite dev server proxy needs to point to the processor's SignalR hub
- In production, Nginx proxies `/hub/*` to the processor service
- For local dev, update `vite.config.ts` to proxy `/hub` to `http://localhost:5050`
- Tailwind uses a custom `pulse-*` color palette defined in `tailwind.config.js`
- D3.js chart operates on raw SVG — no React wrapper library needed

**Zustand store architecture:**

```
telemetryStore
├── streams: Map<string, TelemetryPoint[]>    // 60-second sliding window per sensor
├── sensors: Map<string, SensorState>          // Latest reading + alert status
├── alerts: ThresholdAlert[]                   // Max 100, newest first
├── pushTelemetry(batch)                       // Called from useSignalR every 100ms
├── pushAlert(alert)                           // Called on ReceiveAlert event
└── acknowledgeAlert(id)                       // Called from LiveAlertFeed ACK button
```

### Simulator (Node.js)

**Location:** `simulator/`

```bash
# Install dependencies
cd simulator
npm install

# Set environment variables
export WS_URL=ws://localhost:8085
export SENSORS_COUNT=8
export INTERVAL_MS=25
export BURST_SIZE=25

# Run
node simulator.js
```

**Key file:** `simulator.js` — single-file phase-based FSM that generates realistic sensor patterns.

**Sensor types:**

| Prefix | Metric | Base Range | High Threshold |
|--------|--------|------------|:---:|
| TEMP | temperature | 25–70°C | 85 |
| PRESS | pressure | 40–110 PSI | 150 |
| HUM | humidity | 35–75 %RH | 95 |

---

## Docker Development

### Build Commands

```bash
# Build all images
docker compose build

# Build a specific service
docker compose build processor

# Build with no cache (clean rebuild)
docker compose build --no-cache processor

# Build and start
docker compose up --build -d
```

### Multi-Stage Builds

All custom services use multi-stage Docker builds for minimal image sizes:

**Ingestion Service (Node.js):**
```dockerfile
# Stage 1: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

**Processing Service (.NET):**
```dockerfile
# Stage 1: Build + publish
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
# ...publish to /app/publish

# Stage 2: Runtime
FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "PulseProcessor.dll"]
```

**Frontend (React → Nginx):**
```dockerfile
# Stage 1: Vite build
FROM node:20-alpine AS builder
# ...npm run build

# Stage 2: Nginx serving
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

---

## Code Architecture

### Ingestion Service — Layered I/O

```
WebSocket Layer        → Accept connections, parse JSON, validate
    │
    ▼
Buffer Layer           → Micro-batch (50ms / 200 events)
    │
    ▼
Redis Layer            → Pipeline XADD, flush batch
    │
    ▼
Metrics Layer          → Prometheus counters/gauges/histograms
```

### Processing Service — Pipeline Pattern

```
Consumer Worker Loop (BackgroundService)
    │
    ├── 1. XREADGROUP → raw Redis entries
    ├── 2. Parse → TelemetryEvent[] (failures → DLQ)
    ├── 3. Evaluate → ThresholdAlert[] (with cooldown)
    ├── 4. Persist telemetry → TimescaleDB COPY
    ├── 5. Persist alerts → TimescaleDB INSERT
    ├── 6. Broadcast → SignalR hub
    └── 7. ACK → Redis consumer group
```

### Frontend — Unidirectional Data Flow

```
SignalR events → useSignalR hook → bufferRef
                                       │
                                  100ms interval
                                       │
                                       ▼
                                 Zustand store
                                       │
                              ┌────────┼────────┐
                              ▼        ▼        ▼
                           Charts   Cards    Alerts
                          (D3.js)  (React)  (React)
```

---

## Coding Conventions

### TypeScript (Ingestion, Frontend)

- **Strict mode** enabled (`"strict": true` in tsconfig)
- **Interfaces** for data shapes (not type aliases for objects)
- **Async/await** over raw promises
- **Const assertions** for configuration objects
- **No `any`** — use `unknown` for external data, then narrow

### C# (Processing Service)

- **Record types** or `sealed class` for immutable domain models
- **`required` keyword** for mandatory properties
- **`init` accessors** for immutable initialization
- **Dependency injection** via constructor (registered in `Program.cs`)
- **IHostedService** for background workers
- **Async throughout** — all I/O operations are async

### React (Frontend)

- **Functional components** with hooks (no class components)
- **Custom hooks** for side effects (`useSignalR`)
- **Zustand** for global state (no prop drilling)
- **Zustand selectors** for memoized subscriptions
- **D3.js** uses `useRef` + `useEffect` for direct DOM manipulation
- **Tailwind CSS** for styling (no CSS modules or styled-components)

---

## Testing

### Manual Testing

#### Send a Single Event

```javascript
const ws = new WebSocket("ws://localhost:8085");
ws.onopen = () => {
  ws.send(JSON.stringify({
    sensorId: "TEMP-TEST-001",
    metricType: "temperature",
    value: 72.5,
    unit: "°C",
    timestamp: new Date().toISOString()
  }));
};
ws.onmessage = (e) => console.log("Response:", e.data);
```

#### Trigger a Threshold Alert

```javascript
// Temperature > 85.0 triggers CRITICAL alert
ws.send(JSON.stringify({
  sensorId: "TEMP-TEST-001",
  metricType: "temperature",
  value: 91.3,
  unit: "°C",
  timestamp: new Date().toISOString()
}));
// Wait 30+ seconds before sending again (cooldown)
```

#### Verify Data in TimescaleDB

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

#### Check Redis State

```bash
# Stream length
docker exec pulse-redis redis-cli XLEN telemetry:inbound

# Consumer group status
docker exec pulse-redis redis-cli XINFO GROUPS telemetry:inbound

# DLQ entries
docker exec pulse-redis redis-cli LRANGE telemetry_errors 0 9
```

#### Check Metrics

```bash
# Ingestor metrics
curl http://localhost:9100/metrics

# Processor metrics
curl http://localhost:5050/metrics
```

---

## Adding New Features

### Adding a New Metric Type

1. **Simulator** (`simulator/simulator.js`): Add sensor configuration with base range and threshold
2. **Threshold config** (`.env`): Add `ALERT_<METRIC>_HIGH` and optionally `ALERT_<METRIC>_LOW`
3. **Processing service** (`ThresholdAlertService.cs`): Load new threshold from environment variable
4. **Frontend** (`TelemetryChart.tsx`): Chart automatically renders any metric type from the stream
5. **Dashboard** (`SensorCard.tsx`): Cards auto-populate from Zustand sensor map

### Adding a New Dashboard Component

1. Create component in `frontend/src/components/<category>/`
2. Subscribe to Zustand store with a selector: `const data = useTelemetryStore(s => s.something)`
3. Add component to `App.tsx` layout grid
4. For D3.js charts: use `useRef` for SVG container + `useEffect` for D3 bindings

### Adding a New Prometheus Metric

**Ingestion Service (Node.js):**
```typescript
import { Counter, Histogram, Gauge } from "prom-client";

const myMetric = new Counter({
  name: "pulse_my_metric_total",
  help: "Description of what this metric tracks",
});

// Increment in your code
myMetric.inc();
```

**Processing Service (.NET):**
```csharp
using Prometheus;

private static readonly Counter MyMetric = Metrics.CreateCounter(
    "pulse_my_metric_total",
    "Description of what this metric tracks"
);

// Increment in your code
MyMetric.Inc();
```

Then add a panel in `infrastructure/grafana/dashboards/pulse-health.json` or create one manually in Grafana UI.

### Adding a New Processing Step

1. Create a new service class in `processing-service/Services/`
2. Register it in `Program.cs` DI container
3. Inject it into `TelemetryConsumerWorker` via constructor
4. Call it in the processing pipeline (between parse and persist)

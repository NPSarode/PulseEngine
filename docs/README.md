<div align="center">

# PulseEngine Documentation

### Distributed Event-Driven IoT Monitoring System

</div>

---

## Documentation Index

Welcome to the PulseEngine documentation. This guide covers everything from architecture decisions to deployment, development workflows, and troubleshooting.

### Quick Links

| Document | Description |
|----------|-------------|
| [Architecture & Design](./architecture.md) | System architecture, design decisions, data flow, and technology rationale |
| [API Reference](./api-reference.md) | WebSocket, SignalR, and HTTP endpoint specifications |
| [Deployment Guide](./deployment-guide.md) | Docker Compose setup, configuration, scaling, and production considerations |
| [Development Guide](./development-guide.md) | Local development setup, project structure, coding conventions, and contributing |
| [Database Schema](./database-schema.md) | TimescaleDB schema, hypertable configuration, indexes, policies, and queries |
| [Monitoring & Observability](./monitoring-guide.md) | Prometheus metrics, Grafana dashboards, alerting rules, and PromQL examples |
| [Troubleshooting](./troubleshooting.md) | Common issues, debugging commands, and resolution guides |

---

### System Overview

PulseEngine is a distributed, event-driven IoT monitoring system designed for Industry 4.0 environments. It ingests, processes, and visualizes real-time telemetry from 10,000+ sensors at sub-200ms end-to-end latency.

```
Sensors ──WS──▶ Ingestor ──XADD──▶ Redis Stream ──XREADGROUP──▶ Processor
                                                                    │
                                                    ┌───────────────┼────────────┐
                                                    ▼               ▼            ▼
                                              TimescaleDB     SignalR Hub    Alert Engine
                                              (persistence)   (real-time)   (thresholds)
                                                                    │
                                                                    ▼
                                                              React Dashboard
                                                              (D3.js + Zustand)
```

### Tech Stack at a Glance

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Ingestion | Node.js 20, TypeScript, WebSocket | High-concurrency sensor connections |
| Buffering | Redis 7 Streams | Durable, ordered event log with consumer groups |
| Processing | .NET Core 8, C#, SignalR | Threshold evaluation, persistence, real-time push |
| Persistence | TimescaleDB (PostgreSQL 16) | Time-series storage with automatic management |
| Frontend | React 18, D3.js, Zustand, Tailwind | Real-time industrial monitoring dashboard |
| Observability | Prometheus, Grafana | Metrics collection and visualization |
| Orchestration | Docker Compose | Multi-service deployment |

### Getting Started

```bash
# Clone and launch the entire system
cd PulseEngine
docker compose up --build

# Access points
# Dashboard:  http://localhost:3000
# Grafana:    http://localhost:3001 (admin / pulse2026)
# Prometheus: http://localhost:9090
```

For detailed setup instructions, see the [Deployment Guide](./deployment-guide.md).
For development workflows, see the [Development Guide](./development-guide.md).

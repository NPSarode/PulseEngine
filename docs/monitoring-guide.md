# Monitoring & Observability Guide

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prometheus](#prometheus)
  - [Configuration](#prometheus-configuration)
  - [Metrics Reference](#metrics-reference)
  - [PromQL Queries](#promql-queries)
- [Grafana](#grafana)
  - [Access & Setup](#access--setup)
  - [Pre-built Dashboard](#pre-built-dashboard)
  - [Custom Dashboards](#custom-dashboards)
- [Alerting Rules](#alerting-rules)
- [Key Metrics to Watch](#key-metrics-to-watch)
- [Dead Letter Queue Monitoring](#dead-letter-queue-monitoring)
- [Health Check Commands](#health-check-commands)

---

## Overview

PulseEngine includes a full observability stack for monitoring its own health:

| Component | Role | Port |
|-----------|------|------|
| **Prometheus** | Metrics collection & storage (TSDB) | 9090 |
| **Grafana** | Visualization & alerting dashboards | 3001 |
| **Ingestor `/metrics`** | Node.js process + custom metrics | 9100 |
| **Processor `/metrics`** | .NET process + custom metrics | 5050 |

---

## Architecture

```
┌────────────────┐           ┌────────────────┐
│   Ingestor     │ :9100     │   Processor    │ :5050
│   /metrics     │◀──┐       │   /metrics     │◀──┐
└────────────────┘   │       └────────────────┘   │
                     │ scrape (15s)                │ scrape (15s)
                     │                             │
                ┌────┴─────────────────────────────┴────┐
                │           Prometheus                   │
                │           :9090                        │
                │                                        │
                │  • 15-second scrape interval            │
                │  • Local TSDB storage                  │
                │  • PromQL query engine                 │
                └────────────────┬───────────────────────┘
                                 │ PromQL data source
                                 ▼
                ┌────────────────────────────────────────┐
                │           Grafana                      │
                │           :3001                        │
                │                                        │
                │  • Auto-provisioned Prometheus source   │
                │  • Pre-built PulseEngine Health board   │
                │  • 14 panels across 2 rows             │
                └────────────────────────────────────────┘
```

---

## Prometheus

### Prometheus Configuration

**File:** `infrastructure/prometheus.yml`

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

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

**Access:** http://localhost:9090

### Metrics Reference

#### Ingestion Service Metrics (Node.js)

**Custom Metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `pulse_ws_connections_active` | Gauge | Currently active WebSocket connections |
| `pulse_ws_messages_received_total` | Counter | Total messages received from sensors |
| `pulse_redis_pushes_total` | Counter | Total events pushed to Redis Stream |
| `pulse_batch_flush_duration_seconds` | Histogram | Time to execute a Redis pipeline batch |

**Auto-collected Node.js Metrics** (via `prom-client` default metrics):

| Metric | Type | Description |
|--------|------|-------------|
| `nodejs_heap_size_total_bytes` | Gauge | V8 heap total allocation |
| `nodejs_heap_size_used_bytes` | Gauge | V8 heap currently used |
| `nodejs_external_memory_bytes` | Gauge | Memory for C++ objects bound to JS |
| `nodejs_eventloop_lag_seconds` | Gauge | Event loop lag (delay in processing) |
| `nodejs_active_handles_total` | Gauge | Active libuv handles (sockets, timers) |
| `nodejs_gc_duration_seconds` | Histogram | Garbage collection pause duration |

#### Processing Service Metrics (.NET)

| Metric | Type | Description |
|--------|------|-------------|
| `pulse_events_processed_total` | Counter | Total events successfully processed |
| `pulse_batch_size` | Histogram | Number of events per processing batch |
| `pulse_processing_duration_seconds` | Histogram | Full batch processing duration (parse → persist → broadcast) |
| `pulse_db_write_duration_seconds` | Histogram | TimescaleDB COPY write duration |
| `pulse_alerts_generated_total` | Counter | Total threshold alerts created |
| `pulse_signalr_connections` | Gauge | Active SignalR (dashboard) connections |
| `pulse_dlq_messages_total` | Counter | Total messages routed to Dead Letter Queue |
| `pulse_dlq_length` | Gauge | Current DLQ queue size |

### PromQL Queries

#### Throughput

```promql
# Events processed per second (1-minute rate)
rate(pulse_events_processed_total[1m])

# Messages received per second (ingestion)
rate(pulse_ws_messages_received_total[1m])

# Redis pushes per second
rate(pulse_redis_pushes_total[1m])

# Alert generation rate
rate(pulse_alerts_generated_total[1m])
```

#### Latency

```promql
# P50 processing latency
histogram_quantile(0.50, rate(pulse_processing_duration_seconds_bucket[5m]))

# P95 processing latency
histogram_quantile(0.95, rate(pulse_processing_duration_seconds_bucket[5m]))

# P99 processing latency
histogram_quantile(0.99, rate(pulse_processing_duration_seconds_bucket[5m]))

# P95 database write latency
histogram_quantile(0.95, rate(pulse_db_write_duration_seconds_bucket[5m]))

# P95 Redis batch flush duration
histogram_quantile(0.95, rate(pulse_batch_flush_duration_seconds_bucket[5m]))

# Average batch size
rate(pulse_batch_size_sum[5m]) / rate(pulse_batch_size_count[5m])
```

#### Connections

```promql
# Active WebSocket connections (sensors)
pulse_ws_connections_active

# Active SignalR connections (dashboards)
pulse_signalr_connections
```

#### Health

```promql
# Event loop lag (should be < 100ms)
nodejs_eventloop_lag_seconds

# Node.js heap usage ratio
nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes

# DLQ growth rate (should be 0 in healthy state)
rate(pulse_dlq_messages_total[5m])

# Current DLQ depth
pulse_dlq_length
```

---

## Grafana

### Access & Setup

| Property | Value |
|----------|-------|
| URL | http://localhost:3001 |
| Username | `admin` |
| Password | `pulse2026` |

Grafana is **auto-provisioned** at startup with:
- Prometheus data source (pre-configured)
- PulseEngine Health dashboard (pre-built, 14 panels)

### Pre-built Dashboard

**Name:** PulseEngine Health
**Location:** `infrastructure/grafana/dashboards/pulse-health.json`

The dashboard contains 14 panels organized in 2 rows:

#### Row 1: Processor Metrics

| Panel | Metric | Visualization |
|-------|--------|--------------|
| Events/sec | `rate(pulse_events_processed_total[1m])` | Graph |
| Batch Size | `pulse_batch_size` histogram | Heatmap |
| Processing Duration P50/P95/P99 | `histogram_quantile(...)` | Graph with 3 series |
| DB Write Duration P95 | `histogram_quantile(0.95, ...db_write...)` | Graph |
| SignalR Connections | `pulse_signalr_connections` | Gauge |
| Alerts/sec | `rate(pulse_alerts_generated_total[1m])` | Graph |
| DLQ Count | `pulse_dlq_messages_total` | Stat |
| DLQ Queue Length | `pulse_dlq_length` | Stat |

#### Row 2: Ingestor Metrics

| Panel | Metric | Visualization |
|-------|--------|--------------|
| WebSocket Connections | `pulse_ws_connections_active` | Gauge |
| Messages/sec | `rate(pulse_ws_messages_received_total[1m])` | Graph |
| Redis Push/sec | `rate(pulse_redis_pushes_total[1m])` | Graph |
| Flush Duration P95 | `histogram_quantile(0.95, ...flush...)` | Graph |
| Heap Memory | `nodejs_heap_size_used_bytes` | Graph |
| Event Loop Lag | `nodejs_eventloop_lag_seconds` | Graph |

### Custom Dashboards

To create additional dashboards:

1. Navigate to Grafana (http://localhost:3001)
2. Click **+** → **Dashboard**
3. Add panels using PromQL queries from the [reference above](#promql-queries)
4. Export as JSON: **Dashboard Settings** → **JSON Model** → Copy
5. Save to `infrastructure/grafana/dashboards/` for auto-provisioning

---

## Alerting Rules

While PulseEngine doesn't ship with pre-configured Grafana alerts, here are recommended rules to set up:

### Critical Alerts

| Condition | PromQL | Severity | Description |
|-----------|--------|----------|-------------|
| Processor stalled | `rate(pulse_events_processed_total[2m]) == 0` | Critical | No events processed in 2 minutes |
| DLQ growing | `rate(pulse_dlq_messages_total[5m]) > 0` | Warning | Malformed data entering the system |
| DLQ backlog | `pulse_dlq_length > 100` | Critical | Significant number of failed events |
| High latency | `histogram_quantile(0.95, rate(pulse_processing_duration_seconds_bucket[5m])) > 1` | Warning | P95 processing > 1 second |
| No dashboards | `pulse_signalr_connections == 0` | Info | No operator dashboards connected |
| Event loop lag | `nodejs_eventloop_lag_seconds > 0.1` | Warning | Ingestor under CPU stress |
| High memory | `nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes > 0.9` | Warning | Ingestor heap > 90% |

### Setting Up Grafana Alerts

1. Open the target panel in edit mode
2. Go to **Alert** tab
3. Click **Create alert rule from this panel**
4. Configure condition, evaluation interval, and notification channel
5. Add notification channels (email, Slack, PagerDuty, etc.) via **Alerting** → **Contact points**

---

## Key Metrics to Watch

### Healthy System Indicators

| Metric | Healthy Range | Concern |
|--------|--------------|---------|
| `rate(pulse_events_processed_total[1m])` | > 0, matching ingestion rate | 0 = processor stalled |
| `pulse_ws_connections_active` | Equal to sensor count | Dropping = sensors disconnecting |
| `pulse_signalr_connections` | ≥ 1 | 0 = no operator dashboards |
| `pulse_dlq_length` | 0 | > 0 = data quality issues |
| P95 processing duration | < 200ms | > 1s = performance degradation |
| Event loop lag | < 10ms | > 100ms = ingestor overloaded |
| Heap usage ratio | < 70% | > 90% = memory pressure |

### Capacity Planning Metrics

| Metric | What It Tells You |
|--------|-------------------|
| `rate(pulse_ws_messages_received_total[1m])` | Ingestion throughput — approaching `INGESTOR_MAX_CONNECTIONS`? |
| `pulse_batch_size` histogram | Are batches filling up? If consistently at `PROCESSOR_BATCH_SIZE`, consider increasing. |
| `pulse_db_write_duration_seconds` P95 | Database write latency — disk I/O bottleneck? |
| `nodejs_active_handles_total` | Number of active connections — approaching OS file descriptor limits? |

---

## Dead Letter Queue Monitoring

The DLQ captures malformed or unparseable events. In a healthy system, the DLQ should be empty.

### Prometheus Metrics

```promql
# Total messages ever sent to DLQ (monotonically increasing)
pulse_dlq_messages_total

# Current queue depth (should be 0 in steady state)
pulse_dlq_length

# DLQ growth rate (should be 0)
rate(pulse_dlq_messages_total[5m])
```

### Manual Inspection

```bash
# View latest 10 DLQ entries
docker exec pulse-redis redis-cli LRANGE telemetry_errors 0 9

# Total DLQ size
docker exec pulse-redis redis-cli LLEN telemetry_errors

# View a specific entry (pretty-printed)
docker exec pulse-redis redis-cli LINDEX telemetry_errors 0 | python3 -m json.tool

# Clear DLQ after investigation
docker exec pulse-redis redis-cli DEL telemetry_errors
```

### Common DLQ Entry Causes

| Error Reason | Cause | Fix |
|-------------|-------|-----|
| `Missing required field: sensorId` | Sensor sending malformed JSON | Fix sensor firmware/configuration |
| `Unparseable value: 'NaN'` | Sensor sending non-numeric values | Add sensor-side validation |
| `Missing required field: value` | Incomplete payload | Check sensor network stability |

---

## Health Check Commands

Quick commands to verify system health:

```bash
# All containers running?
docker compose ps

# Redis responding?
docker exec pulse-redis redis-cli PING
# Expected: PONG

# TimescaleDB ready?
docker exec pulse-timescaledb pg_isready -U pulse_admin -d pulseengine
# Expected: accepting connections

# Stream status
docker exec pulse-redis redis-cli XLEN telemetry:inbound
# Expected: > 0 (events flowing)

# Consumer group status
docker exec pulse-redis redis-cli XINFO GROUPS telemetry:inbound
# Expected: shows pulse-processors group with pending count near 0

# DLQ check
docker exec pulse-redis redis-cli LLEN telemetry_errors
# Expected: 0

# Recent telemetry in DB
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT COUNT(*) FROM telemetry WHERE recorded_at > NOW() - INTERVAL '1 minute';"
# Expected: > 0

# Unacknowledged alerts
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT COUNT(*) FROM alerts WHERE acknowledged = FALSE;"

# Ingestor metrics accessible?
curl -s http://localhost:9100/metrics | head -5

# Processor metrics accessible?
curl -s http://localhost:5050/metrics | head -5

# Prometheus targets healthy?
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool
```

# Deployment Guide

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Docker Compose Services](#docker-compose-services)
- [Startup Order & Health Checks](#startup-order--health-checks)
- [Configuration Reference](#configuration-reference)
- [Access Points](#access-points)
- [Common Operations](#common-operations)
- [Scaling](#scaling)
- [Production Considerations](#production-considerations)
- [Resource Requirements](#resource-requirements)

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20.10+)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2.0+ or bundled with Docker Desktop)
- **Minimum:** 4GB RAM, 2 CPU cores
- **Recommended:** 8GB RAM, 4 CPU cores (for full 8-service stack with monitoring)

---

## Quick Start

```bash
# Clone the repository
git clone <repository-url>
cd PulseEngine

# Launch all 8 services
docker compose up --build

# Launch in detached mode
docker compose up --build -d

# View logs
docker compose logs -f

# View logs for a specific service
docker compose logs -f processor
```

The system will be fully operational within 30-60 seconds depending on build cache and hardware.

---

## Docker Compose Services

PulseEngine runs 8 services orchestrated via Docker Compose:

| Service | Image | Build Context | Internal Port | External Port | Purpose |
|---------|-------|---------------|:---:|:---:|---------|
| `redis` | `redis:7-alpine` | — | 6379 | 6379 | Event buffer (Redis Streams) |
| `timescaledb` | `timescale/timescaledb:latest-pg16` | — | 5432 | 5432 | Time-series persistence |
| `ingestor` | Custom (Node.js) | `./ingestion-service` | 8085, 9100 | 8085, 9100 | WebSocket sensor intake |
| `processor` | Custom (.NET) | `./processing-service` | 5050 | 5050 | Event processing + SignalR |
| `dashboard` | Custom (React → Nginx) | `./frontend` | 80 | 3000 | Browser dashboard |
| `simulator` | Custom (Node.js) | `./simulator` | — | — | Sensor data generator |
| `prometheus` | `prom/prometheus:latest` | — | 9090 | 9090 | Metrics collection |
| `grafana` | `grafana/grafana:latest` | — | 3000 | 3001 | Metrics dashboards |

### Volume Mounts

| Volume | Service | Container Path | Purpose |
|--------|---------|---------------|---------|
| `redis_data` | redis | `/data` | Redis persistence (AOF/RDB) |
| `pg_data` | timescaledb | `/var/lib/postgresql/data` | PostgreSQL data directory |
| `prometheus_data` | prometheus | `/prometheus` | Prometheus TSDB |
| `grafana_data` | grafana | `/var/lib/grafana` | Grafana config + dashboards |
| `./infrastructure/init-db.sql` | timescaledb | `/docker-entrypoint-initdb.d/` | Database initialization |
| `./infrastructure/prometheus.yml` | prometheus | `/etc/prometheus/prometheus.yml` | Scrape configuration |
| `./infrastructure/grafana/` | grafana | `/etc/grafana/` + `/var/lib/grafana/dashboards/` | Dashboard provisioning |

---

## Startup Order & Health Checks

Docker Compose enforces dependency ordering with health checks:

```
Step 1: Redis         ─── health: redis-cli PING (every 5s, 5 retries)
Step 2: TimescaleDB   ─── health: pg_isready (every 5s, 5 retries)
                           └── runs init-db.sql on first boot
Step 3: Ingestor      ─── depends_on: redis (healthy)
Step 4: Processor     ─── depends_on: redis (healthy) + timescaledb (healthy)
Step 5: Dashboard     ─── depends_on: processor (started)
Step 6: Simulator     ─── depends_on: ingestor (started)
Step 7: Prometheus    ─── depends_on: processor + ingestor (started)
Step 8: Grafana       ─── depends_on: prometheus (started)
```

**Expected startup log sequence:**

```
pulse-redis       | Ready to accept connections
pulse-timescaledb | database system is ready to accept connections
pulse-ingestor    | WebSocket server listening on port 8085
pulse-ingestor    | Metrics server listening on port 9100
pulse-processor   | Processing service started. Consuming from telemetry:inbound
pulse-dashboard   | nginx: started
pulse-simulator   | Connected to ws://ingestor:8085, sending data...
pulse-prometheus  | Server is ready to receive web requests
pulse-grafana     | HTTP Server Listen
```

---

## Configuration Reference

### Environment Variables (`.env`)

All services read from the shared `.env` file:

#### Redis Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `redis` | Redis hostname (Docker service name) |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_STREAM_KEY` | `telemetry:inbound` | Stream name for telemetry events |

#### PostgreSQL / TimescaleDB

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `timescaledb` | Database hostname |
| `POSTGRES_PORT` | `5432` | Database port |
| `POSTGRES_DB` | `pulseengine` | Database name |
| `POSTGRES_USER` | `pulse_admin` | Database user |
| `POSTGRES_PASSWORD` | `Pulse$ecure2026!` | Database password |

#### Ingestion Service

| Variable | Default | Description |
|----------|---------|-------------|
| `INGESTOR_WS_PORT` | `8085` | WebSocket listen port |
| `INGESTOR_MAX_CONNECTIONS` | `10000` | Max concurrent WebSocket connections |

#### Processing Service

| Variable | Default | Description |
|----------|---------|-------------|
| `PROCESSOR_CONSUMER_GROUP` | `pulse-processors` | Redis consumer group name |
| `PROCESSOR_CONSUMER_NAME` | `processor-1` | Consumer instance name (unique per instance) |
| `PROCESSOR_BATCH_SIZE` | `100` | Max events per XREADGROUP call |
| `PROCESSOR_BLOCK_MS` | `2000` | Block timeout for XREADGROUP (ms) |

#### Alert Thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `ALERT_TEMPERATURE_HIGH` | `85.0` | Temperature upper threshold (°C) |
| `ALERT_TEMPERATURE_LOW` | `-10.0` | Temperature lower threshold (°C) |
| `ALERT_PRESSURE_HIGH` | `150.0` | Pressure upper threshold (PSI) |
| `ALERT_HUMIDITY_HIGH` | `95.0` | Humidity upper threshold (%RH) |

### Simulator Configuration

Set directly in `docker-compose.yml` under the `simulator` service:

| Variable | Default | Description |
|----------|---------|-------------|
| `SENSORS_COUNT` | `8` | Number of simulated sensors |
| `INTERVAL_MS` | `25` | Milliseconds between ticks |
| `BURST_SIZE` | `25` | Events sent per tick |

**Throughput formula:** `events/sec = BURST_SIZE × (1000 / INTERVAL_MS)`

| Target evt/s | INTERVAL_MS | BURST_SIZE |
|:---:|:---:|:---:|
| 100 | 100 | 10 |
| 500 | 50 | 25 |
| 1,000 | 25 | 25 |
| 2,000 | 50 | 100 |
| 5,000 | 20 | 100 |

### Grafana Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GF_SECURITY_ADMIN_USER` | `admin` | Grafana admin username |
| `GF_SECURITY_ADMIN_PASSWORD` | `pulse2026` | Grafana admin password |

---

## Access Points

| Interface | URL | Credentials |
|-----------|-----|-------------|
| Dashboard | http://localhost:3000 | — |
| Grafana | http://localhost:3001 | admin / pulse2026 |
| Prometheus | http://localhost:9090 | — |
| WebSocket (Ingestor) | ws://localhost:8085 | — |
| SignalR Hub | http://localhost:5050/hub/telemetry | — |
| Processor Metrics | http://localhost:5050/metrics | — |
| Ingestor Metrics | http://localhost:9100/metrics | — |
| Redis CLI | `docker exec pulse-redis redis-cli` | — |
| TimescaleDB | `docker exec -it pulse-timescaledb psql -U pulse_admin -d pulseengine` | — |

---

## Common Operations

### Start / Stop

```bash
# Start all services
docker compose up --build -d

# Stop all services (preserve data volumes)
docker compose down

# Stop and remove all data volumes
docker compose down -v

# Restart a single service
docker compose restart processor

# Rebuild and restart a single service
docker compose up --build -d processor
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f processor

# Last 100 lines
docker compose logs --tail=100 processor

# Multiple services
docker compose logs -f ingestor processor
```

### Clean Restart (Reset All Data)

```bash
docker compose down
docker volume rm pulseengine_redis_data pulseengine_pg_data \
  pulseengine_prometheus_data pulseengine_grafana_data
docker compose up --build
```

### Connect to Services

```bash
# Redis CLI
docker exec -it pulse-redis redis-cli

# TimescaleDB SQL shell
docker exec -it pulse-timescaledb psql -U pulse_admin -d pulseengine

# Ingestor container shell
docker exec -it pulse-ingestor sh

# Processor container shell
docker exec -it pulse-processor sh
```

### Check Service Health

```bash
# Container status
docker compose ps

# Redis health
docker exec pulse-redis redis-cli PING

# TimescaleDB health
docker exec pulse-timescaledb pg_isready -U pulse_admin -d pulseengine

# Stream status
docker exec pulse-redis redis-cli XLEN telemetry:inbound
docker exec pulse-redis redis-cli XINFO GROUPS telemetry:inbound

# DLQ status
docker exec pulse-redis redis-cli LLEN telemetry_errors
```

---

## Scaling

### Horizontal: Multiple Processor Instances

Add processor instances to the consumer group for linear throughput scaling:

```yaml
# docker-compose.yml additions
processor-2:
  build: ./processing-service
  environment:
    REDIS_HOST: redis
    REDIS_PORT: 6379
    REDIS_STREAM_KEY: telemetry:inbound
    POSTGRES_HOST: timescaledb
    POSTGRES_PORT: 5432
    POSTGRES_DB: pulseengine
    POSTGRES_USER: pulse_admin
    POSTGRES_PASSWORD: Pulse$ecure2026!
    PROCESSOR_CONSUMER_GROUP: pulse-processors    # Same group
    PROCESSOR_CONSUMER_NAME: processor-2           # Unique name
    PROCESSOR_BATCH_SIZE: 100
    PROCESSOR_BLOCK_MS: 2000
    ALERT_TEMPERATURE_HIGH: 85.0
    ALERT_TEMPERATURE_LOW: -10.0
    ALERT_PRESSURE_HIGH: 150.0
    ALERT_HUMIDITY_HIGH: 95.0
  depends_on:
    redis:
      condition: service_healthy
    timescaledb:
      condition: service_healthy
```

Redis consumer groups automatically distribute events across all consumers in the group.

### Vertical: Tuning Parameters

| Parameter | Effect of Increase | Trade-off |
|-----------|-------------------|-----------|
| `PROCESSOR_BATCH_SIZE` | Higher throughput per cycle | Higher per-batch latency |
| `PROCESSOR_BLOCK_MS` | Fewer empty polls | Higher maximum latency |
| `INGESTOR_MAX_CONNECTIONS` | More concurrent sensors | More memory per connection (~30KB) |
| Micro-batch interval (code) | Bigger batches, better pipeline efficiency | Higher ingestion latency |

---

## Production Considerations

### Security

- **Change default passwords** in `.env` (`POSTGRES_PASSWORD`, Grafana admin password)
- **Do not expose Redis/TimescaleDB ports** to the public internet — remove port mappings or use network policies
- **Enable TLS** on WebSocket connections for sensor-to-ingestor communication
- **Use environment-specific `.env` files** (`.env.production`, `.env.staging`)
- **Rotate secrets** using Docker secrets or external secret management (Vault, AWS Secrets Manager)

### Persistence

- **Redis:** Configured with RDB snapshots via volume mount. For stronger durability, enable AOF in `redis.conf`
- **TimescaleDB:** Standard PostgreSQL WAL. Configure `wal_level = replica` for replication
- **Prometheus:** Local TSDB with volume mount. Default 15-day retention

### Monitoring

- Set up **Grafana alerting rules** for critical metrics:
  - `pulse_dlq_length > 0` — malformed data entering the system
  - `pulse_signalr_connections == 0` — no dashboards connected
  - `rate(pulse_events_processed_total[1m]) == 0` — processor stalled
  - `nodejs_eventloop_lag_seconds > 0.1` — ingestor under stress
- **Export Grafana dashboards** to JSON for version control

### Backup

```bash
# Backup TimescaleDB
docker exec pulse-timescaledb pg_dump -U pulse_admin pulseengine > backup.sql

# Restore TimescaleDB
docker exec -i pulse-timescaledb psql -U pulse_admin pulseengine < backup.sql

# Backup Redis
docker exec pulse-redis redis-cli BGSAVE
docker cp pulse-redis:/data/dump.rdb ./redis-backup.rdb
```

### Network Configuration

For production deployment behind a load balancer:

```nginx
# Example: Nginx reverse proxy for PulseEngine
upstream dashboard {
    server localhost:3000;
}

upstream signalr {
    server localhost:5050;
}

server {
    listen 443 ssl;
    server_name pulse.example.com;

    # Dashboard
    location / {
        proxy_pass http://dashboard;
    }

    # SignalR WebSocket
    location /hub/ {
        proxy_pass http://signalr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## Resource Requirements

### Minimum (Development)

| Resource | Amount |
|----------|--------|
| RAM | 4 GB |
| CPU | 2 cores |
| Disk | 5 GB (images + data) |
| Network | Localhost only |

### Recommended (Staging/Production)

| Resource | Amount |
|----------|--------|
| RAM | 8-16 GB |
| CPU | 4+ cores |
| Disk | 50+ GB (SSD recommended for TimescaleDB) |
| Network | Dedicated subnet for inter-service communication |

### Per-Service Memory Estimates

| Service | Idle | Under Load (1000 evt/s) |
|---------|------|------------------------|
| Redis | ~10 MB | ~100 MB (stream buffer) |
| TimescaleDB | ~100 MB | ~500 MB (shared_buffers + WAL) |
| Ingestor | ~50 MB | ~150 MB (connections + buffers) |
| Processor | ~80 MB | ~200 MB (.NET runtime + batch processing) |
| Dashboard (Nginx) | ~5 MB | ~5 MB (static files) |
| Simulator | ~30 MB | ~50 MB |
| Prometheus | ~100 MB | ~300 MB (TSDB) |
| Grafana | ~100 MB | ~150 MB |
| **Total** | **~475 MB** | **~1.5 GB** |

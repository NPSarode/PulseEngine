# Database Schema

## Table of Contents

- [Overview](#overview)
- [Telemetry Table (Hypertable)](#telemetry-table-hypertable)
- [Alerts Table](#alerts-table)
- [Continuous Aggregates](#continuous-aggregates)
- [Indexes](#indexes)
- [Automated Policies](#automated-policies)
- [Initialization Script](#initialization-script)
- [Common Queries](#common-queries)
- [Schema Diagram](#schema-diagram)

---

## Overview

PulseEngine uses **TimescaleDB** (PostgreSQL 16 extension) for persistent storage. TimescaleDB provides:

- **Hypertables:** Automatic time-based partitioning into chunks
- **Compression:** ~90% storage reduction for older data
- **Retention policies:** Automatic deletion of expired data
- **Continuous aggregates:** Pre-computed rollups for fast queries

**Connection details:**

| Property | Value |
|----------|-------|
| Host | `timescaledb` (Docker) / `localhost` (local) |
| Port | `5432` |
| Database | `pulseengine` |
| User | `pulse_admin` |
| Password | `Pulse$ecure2026!` |

```bash
# Connect via Docker
docker exec -it pulse-timescaledb psql -U pulse_admin -d pulseengine

# Connect directly (if port is exposed)
psql -h localhost -p 5432 -U pulse_admin -d pulseengine
```

---

## Telemetry Table (Hypertable)

The primary table for all sensor readings. Converted to a TimescaleDB hypertable partitioned by `recorded_at`.

### Schema

```sql
CREATE TABLE IF NOT EXISTS telemetry (
    id              BIGSERIAL,
    sensor_id       VARCHAR(64)        NOT NULL,
    metric_type     VARCHAR(32)        NOT NULL,
    value           DOUBLE PRECISION   NOT NULL,
    unit            VARCHAR(16),
    recorded_at     TIMESTAMPTZ        NOT NULL,
    ingested_at     TIMESTAMPTZ        DEFAULT NOW(),
    metadata        JSONB,
    PRIMARY KEY (id, recorded_at)
);
```

### Column Details

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | BIGSERIAL | NO | Auto-increment | Row identifier (part of composite PK with recorded_at) |
| `sensor_id` | VARCHAR(64) | NO | — | Device identifier (e.g., `TEMP-FLOOR3-001`) |
| `metric_type` | VARCHAR(32) | NO | — | Signal category: `temperature`, `pressure`, `humidity` |
| `value` | DOUBLE PRECISION | NO | — | Sensor reading value |
| `unit` | VARCHAR(16) | YES | NULL | Measurement unit: `°C`, `PSI`, `%RH` |
| `recorded_at` | TIMESTAMPTZ | NO | — | When the sensor recorded the reading (hypertable partition key) |
| `ingested_at` | TIMESTAMPTZ | YES | `NOW()` | When the server received and stored the reading |
| `metadata` | JSONB | YES | NULL | Extensible key-value data (location, firmware, etc.) |

### Hypertable Configuration

```sql
SELECT create_hypertable('telemetry', 'recorded_at',
    chunk_time_interval => INTERVAL '1 hour');
```

- **Partition key:** `recorded_at`
- **Chunk interval:** 1 hour
- **Why 1 hour?** Optimal for 10,000+ events/sec write patterns — balances chunk creation overhead vs parallel I/O benefits

### Write Pattern

The processing service uses **Npgsql Binary COPY** for maximum throughput:

```csharp
await using var writer = await conn.BeginBinaryImportAsync(
    "COPY telemetry (sensor_id, metric_type, value, unit, recorded_at, metadata) " +
    "FROM STDIN (FORMAT BINARY)");

foreach (var evt in events)
{
    await writer.StartRowAsync();
    await writer.WriteAsync(evt.SensorId, NpgsqlDbType.Varchar);
    await writer.WriteAsync(evt.MetricType, NpgsqlDbType.Varchar);
    await writer.WriteAsync(evt.Value, NpgsqlDbType.Double);
    // ...
}

await writer.CompleteAsync();
```

**Throughput:** 50,000–100,000 rows/sec (vs ~2,000 rows/sec with individual INSERTs)

---

## Alerts Table

Stores threshold violations for audit trails and dashboard display.

### Schema

```sql
CREATE TABLE IF NOT EXISTS alerts (
    id                  BIGSERIAL        PRIMARY KEY,
    sensor_id           VARCHAR(64)      NOT NULL,
    metric_type         VARCHAR(32)      NOT NULL,
    threshold_value     DOUBLE PRECISION NOT NULL,
    actual_value        DOUBLE PRECISION NOT NULL,
    severity            VARCHAR(16)      DEFAULT 'WARNING',
    message             TEXT,
    triggered_at        TIMESTAMPTZ      DEFAULT NOW(),
    acknowledged        BOOLEAN          DEFAULT FALSE
);
```

### Column Details

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | BIGSERIAL | NO | Auto-increment | Unique alert identifier |
| `sensor_id` | VARCHAR(64) | NO | — | Device that triggered the alert |
| `metric_type` | VARCHAR(32) | NO | — | Which metric breached its threshold |
| `threshold_value` | DOUBLE PRECISION | NO | — | Configured boundary that was exceeded |
| `actual_value` | DOUBLE PRECISION | NO | — | The reading that exceeded the boundary |
| `severity` | VARCHAR(16) | YES | `'WARNING'` | Alert severity: `CRITICAL` or `WARNING` |
| `message` | TEXT | YES | NULL | Human-readable description |
| `triggered_at` | TIMESTAMPTZ | YES | `NOW()` | When the threshold was exceeded |
| `acknowledged` | BOOLEAN | YES | `FALSE` | Whether an operator has acknowledged the alert |

### Write Pattern

Alerts are inserted individually with parameterized queries (not COPY — alert volume is low due to 30s cooldown):

```csharp
await using var cmd = new NpgsqlCommand(
    "INSERT INTO alerts (sensor_id, metric_type, threshold_value, actual_value, severity, message) " +
    "VALUES ($1, $2, $3, $4, $5, $6)", conn);

cmd.Parameters.AddWithValue(alert.SensorId);
cmd.Parameters.AddWithValue(alert.MetricType);
cmd.Parameters.AddWithValue(alert.ThresholdValue);
cmd.Parameters.AddWithValue(alert.ActualValue);
cmd.Parameters.AddWithValue(alert.Severity);
cmd.Parameters.AddWithValue(alert.Message ?? (object)DBNull.Value);

await cmd.ExecuteNonQueryAsync();
```

---

## Continuous Aggregates

Pre-computed 1-minute rollups for fast historical queries.

### Definition

```sql
CREATE MATERIALIZED VIEW telemetry_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', recorded_at) AS bucket,
    sensor_id,
    metric_type,
    MIN(value)   AS min_value,
    AVG(value)   AS avg_value,
    MAX(value)   AS max_value,
    COUNT(*)     AS sample_count
FROM telemetry
GROUP BY bucket, sensor_id, metric_type;
```

### Columns

| Column | Type | Description |
|--------|------|-------------|
| `bucket` | TIMESTAMPTZ | 1-minute time bucket start |
| `sensor_id` | VARCHAR(64) | Device identifier |
| `metric_type` | VARCHAR(32) | Signal category |
| `min_value` | DOUBLE PRECISION | Minimum reading in the bucket |
| `avg_value` | DOUBLE PRECISION | Average reading in the bucket |
| `max_value` | DOUBLE PRECISION | Maximum reading in the bucket |
| `sample_count` | BIGINT | Number of readings in the bucket |

### Refresh Policy

```sql
SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset    => INTERVAL '10 minutes',
    end_offset      => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
```

- **Schedule:** Every 1 minute
- **Start offset:** Refreshes data from 10 minutes ago (catches late arrivals)
- **End offset:** Doesn't include the current incomplete minute

---

## Indexes

### Telemetry Indexes

```sql
-- Sensor time-series queries (e.g., "last 1 hour for sensor X")
CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_time
    ON telemetry (sensor_id, recorded_at DESC);

-- Metric type queries (e.g., "all temperature readings in last hour")
CREATE INDEX IF NOT EXISTS idx_telemetry_metric_type
    ON telemetry (metric_type, recorded_at DESC);
```

### Alert Indexes

```sql
-- Per-sensor alert history
CREATE INDEX IF NOT EXISTS idx_alerts_sensor
    ON alerts (sensor_id, triggered_at DESC);

-- Unacknowledged alerts (partial index — only rows where acknowledged = FALSE)
CREATE INDEX IF NOT EXISTS idx_alerts_unack
    ON alerts (acknowledged, triggered_at DESC)
    WHERE NOT acknowledged;
```

**Why partial index for unacknowledged alerts?** The dashboard primarily queries for active (unacknowledged) alerts. A partial index on `WHERE NOT acknowledged` is smaller and faster than a full index because it only contains the relevant rows.

---

## Automated Policies

### Compression Policy

```sql
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'sensor_id, metric_type',
    timescaledb.compress_orderby = 'recorded_at DESC'
);

SELECT add_compression_policy('telemetry', INTERVAL '2 hours');
```

- **Trigger:** Chunks older than 2 hours
- **Segment by:** `sensor_id`, `metric_type` (keeps related data together for decompression)
- **Order by:** `recorded_at DESC` (newest first within segments)
- **Compression ratio:** ~90% storage reduction
- **Impact:** Compressed chunks are read-only. Queries auto-decompress as needed.

### Retention Policy

```sql
SELECT add_retention_policy('telemetry', INTERVAL '30 days');
```

- **Trigger:** Chunks older than 30 days
- **Action:** Entire chunk dropped (instant — no row-by-row DELETE)
- **Purpose:** Prevents unbounded disk growth
- **Note:** Continuous aggregates (`telemetry_1m`) are NOT affected by this policy — rollups persist independently

### Policy Summary

| Policy | Target | Schedule | Action |
|--------|--------|----------|--------|
| Compression | Chunks > 2 hours | Automatic (TimescaleDB scheduler) | Compress using column-store format |
| Retention | Chunks > 30 days | Automatic (TimescaleDB scheduler) | Drop entire chunk |
| Continuous Aggregate | telemetry_1m | Every 1 minute | Refresh 10m–1m window |

### Data Lifecycle

```
Event ingested
       │
       ▼ (0 - 2 hours)
  Uncompressed chunk
  - Full read/write
  - Indexed by sensor_id, metric_type, recorded_at
       │
       ▼ (2 hours - 30 days)
  Compressed chunk
  - ~90% smaller
  - Read-only (auto-decompresses for queries)
  - Segment by sensor_id, metric_type
       │
       ▼ (> 30 days)
  Dropped (chunk deleted)
  - Instant deletion (no row-by-row DELETE)
  - Continuous aggregates (telemetry_1m) preserved
```

---

## Initialization Script

The full initialization script runs on first boot via Docker's `/docker-entrypoint-initdb.d/` mechanism.

**Location:** `infrastructure/init-db.sql`

**Execution order:**
1. Create `telemetry` table
2. Convert to hypertable (1-hour chunks)
3. Create `alerts` table
4. Create all indexes
5. Set compression configuration
6. Add compression policy (2 hours)
7. Add retention policy (30 days)
8. Create `telemetry_1m` continuous aggregate
9. Add continuous aggregate refresh policy (1 minute)

---

## Common Queries

### Recent Telemetry

```sql
-- Latest 10 readings
SELECT sensor_id, metric_type, value, unit, recorded_at
FROM telemetry
ORDER BY recorded_at DESC
LIMIT 10;

-- Latest reading per sensor
SELECT DISTINCT ON (sensor_id)
    sensor_id, metric_type, value, unit, recorded_at
FROM telemetry
ORDER BY sensor_id, recorded_at DESC;
```

### Time-Range Queries

```sql
-- Last 5 minutes for a specific sensor
SELECT recorded_at, value
FROM telemetry
WHERE sensor_id = 'TEMP-FLOOR3-001'
  AND recorded_at > NOW() - INTERVAL '5 minutes'
ORDER BY recorded_at;

-- Hourly averages for the last 24 hours
SELECT
    time_bucket('1 hour', recorded_at) AS hour,
    sensor_id,
    AVG(value) AS avg_value,
    COUNT(*) AS samples
FROM telemetry
WHERE recorded_at > NOW() - INTERVAL '24 hours'
GROUP BY hour, sensor_id
ORDER BY hour DESC;
```

### Alert Queries

```sql
-- Unacknowledged alerts
SELECT id, sensor_id, metric_type, actual_value, threshold_value,
       severity, message, triggered_at
FROM alerts
WHERE acknowledged = FALSE
ORDER BY triggered_at DESC;

-- Alert count by sensor (last 24 hours)
SELECT sensor_id, COUNT(*) AS alert_count
FROM alerts
WHERE triggered_at > NOW() - INTERVAL '24 hours'
GROUP BY sensor_id
ORDER BY alert_count DESC;

-- Acknowledge an alert
UPDATE alerts SET acknowledged = TRUE WHERE id = 42;

-- Acknowledge all alerts for a sensor
UPDATE alerts SET acknowledged = TRUE
WHERE sensor_id = 'TEMP-FLOOR3-001' AND acknowledged = FALSE;
```

### Continuous Aggregate Queries

```sql
-- 1-minute rollups for the last hour
SELECT bucket, sensor_id, metric_type,
       min_value, avg_value, max_value, sample_count
FROM telemetry_1m
WHERE bucket > NOW() - INTERVAL '1 hour'
ORDER BY bucket DESC;

-- Peak values per sensor today
SELECT sensor_id, metric_type,
       MAX(max_value) AS peak_value
FROM telemetry_1m
WHERE bucket > NOW() - INTERVAL '24 hours'
GROUP BY sensor_id, metric_type
ORDER BY peak_value DESC;
```

### Administrative Queries

```sql
-- Hypertable chunk information
SELECT * FROM timescaledb_information.chunks
WHERE hypertable_name = 'telemetry'
ORDER BY range_start DESC;

-- Compression statistics
SELECT * FROM hypertable_compression_stats('telemetry');

-- Hypertable size
SELECT hypertable_size('telemetry');

-- Detailed size breakdown
SELECT * FROM hypertable_detailed_size('telemetry');

-- Active policies
SELECT * FROM timescaledb_information.jobs
WHERE hypertable_name = 'telemetry';
```

---

## Schema Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    TimescaleDB (pulseengine)                  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  telemetry (hypertable, 1-hour chunks)                │  │
│  │                                                       │  │
│  │  PK: (id, recorded_at)                                │  │
│  │  ├── id              BIGSERIAL                        │  │
│  │  ├── sensor_id       VARCHAR(64)    NOT NULL          │  │
│  │  ├── metric_type     VARCHAR(32)    NOT NULL          │  │
│  │  ├── value           DOUBLE PREC    NOT NULL          │  │
│  │  ├── unit            VARCHAR(16)                      │  │
│  │  ├── recorded_at     TIMESTAMPTZ    NOT NULL [PART]   │  │
│  │  ├── ingested_at     TIMESTAMPTZ    DEFAULT NOW()     │  │
│  │  └── metadata        JSONB                            │  │
│  │                                                       │  │
│  │  IDX: (sensor_id, recorded_at DESC)                   │  │
│  │  IDX: (metric_type, recorded_at DESC)                 │  │
│  │                                                       │  │
│  │  POLICIES:                                            │  │
│  │  ├── Compress: chunks > 2h                            │  │
│  │  └── Retain:   chunks > 30d                           │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│                    (continuous aggregate)                     │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  telemetry_1m (materialized view, auto-refresh 1min)  │  │
│  │                                                       │  │
│  │  ├── bucket          TIMESTAMPTZ (1-min buckets)      │  │
│  │  ├── sensor_id       VARCHAR(64)                      │  │
│  │  ├── metric_type     VARCHAR(32)                      │  │
│  │  ├── min_value       DOUBLE PRECISION                 │  │
│  │  ├── avg_value       DOUBLE PRECISION                 │  │
│  │  ├── max_value       DOUBLE PRECISION                 │  │
│  │  └── sample_count    BIGINT                           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  alerts (standard table)                              │  │
│  │                                                       │  │
│  │  PK: id                                               │  │
│  │  ├── id              BIGSERIAL                        │  │
│  │  ├── sensor_id       VARCHAR(64)    NOT NULL          │  │
│  │  ├── metric_type     VARCHAR(32)    NOT NULL          │  │
│  │  ├── threshold_value DOUBLE PREC    NOT NULL          │  │
│  │  ├── actual_value    DOUBLE PREC    NOT NULL          │  │
│  │  ├── severity        VARCHAR(16)    DEFAULT 'WARNING' │  │
│  │  ├── message         TEXT                             │  │
│  │  ├── triggered_at    TIMESTAMPTZ    DEFAULT NOW()     │  │
│  │  └── acknowledged    BOOLEAN        DEFAULT FALSE     │  │
│  │                                                       │  │
│  │  IDX: (sensor_id, triggered_at DESC)                  │  │
│  │  IDX: (acknowledged, triggered_at DESC)               │  │
│  │        WHERE NOT acknowledged                         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

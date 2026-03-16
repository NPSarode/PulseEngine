-- ═══════════════════════════════════════════════════════════
-- PulseEngine · TimescaleDB Initialization
-- Creates hypertable-backed telemetry storage for IoT signals
-- ═══════════════════════════════════════════════════════════

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─── Telemetry Events Table ───────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry (
    id              BIGSERIAL,
    sensor_id       VARCHAR(64)     NOT NULL,
    metric_type     VARCHAR(32)     NOT NULL,
    value           DOUBLE PRECISION NOT NULL,
    unit            VARCHAR(16),
    recorded_at     TIMESTAMPTZ     NOT NULL,
    ingested_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    metadata        JSONB,
    PRIMARY KEY (id, recorded_at)
);

-- Convert to TimescaleDB hypertable partitioned by recorded_at
-- chunk_time_interval = 1 hour (optimal for 10k+ events/sec)
SELECT create_hypertable(
    'telemetry',
    'recorded_at',
    chunk_time_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- ─── Indexes for Query Performance ───────────────────────
CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_time
    ON telemetry (sensor_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_metric_type
    ON telemetry (metric_type, recorded_at DESC);

-- ─── Alerts Table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
    id              BIGSERIAL       PRIMARY KEY,
    sensor_id       VARCHAR(64)     NOT NULL,
    metric_type     VARCHAR(32)     NOT NULL,
    threshold_value DOUBLE PRECISION NOT NULL,
    actual_value    DOUBLE PRECISION NOT NULL,
    severity        VARCHAR(16)     NOT NULL DEFAULT 'WARNING',
    message         TEXT,
    triggered_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    acknowledged    BOOLEAN         NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_alerts_sensor
    ON alerts (sensor_id, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_unack
    ON alerts (acknowledged, triggered_at DESC)
    WHERE acknowledged = FALSE;

-- ─── Continuous Aggregate for Dashboard ───────────────────
-- 1-minute rollups for real-time dashboards
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', recorded_at) AS bucket,
    sensor_id,
    metric_type,
    AVG(value)   AS avg_value,
    MIN(value)   AS min_value,
    MAX(value)   AS max_value,
    COUNT(*)     AS sample_count
FROM telemetry
GROUP BY bucket, sensor_id, metric_type
WITH NO DATA;

-- Refresh policy: refresh every minute, look back 10 minutes
SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset    => INTERVAL '10 minutes',
    end_offset      => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists   => TRUE
);

-- ─── Retention Policy ─────────────────────────────────────
-- Auto-drop raw data older than 30 days (aggregates preserved)
SELECT add_retention_policy('telemetry',
    drop_after => INTERVAL '30 days',
    if_not_exists => TRUE
);

-- ─── Compression Policy ──────────────────────────────────
-- Compress chunks older than 2 hours for storage efficiency
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'sensor_id, metric_type',
    timescaledb.compress_orderby = 'recorded_at DESC'
);

SELECT add_compression_policy('telemetry',
    compress_after => INTERVAL '2 hours',
    if_not_exists  => TRUE
);

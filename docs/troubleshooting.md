# Troubleshooting Guide

## Table of Contents

- [Quick Diagnostics](#quick-diagnostics)
- [Startup Issues](#startup-issues)
- [Ingestion Issues](#ingestion-issues)
- [Processing Issues](#processing-issues)
- [Database Issues](#database-issues)
- [Dashboard Issues](#dashboard-issues)
- [Redis Issues](#redis-issues)
- [Monitoring Issues](#monitoring-issues)
- [Performance Issues](#performance-issues)
- [Docker Issues](#docker-issues)

---

## Quick Diagnostics

Run this checklist to quickly identify the problem area:

```bash
# 1. Are all containers running?
docker compose ps

# 2. Check for crash loops
docker compose ps --format "table {{.Name}}\t{{.Status}}"

# 3. Redis health
docker exec pulse-redis redis-cli PING

# 4. TimescaleDB health
docker exec pulse-timescaledb pg_isready -U pulse_admin -d pulseengine

# 5. Stream flowing?
docker exec pulse-redis redis-cli XLEN telemetry:inbound

# 6. Events being processed?
docker exec pulse-redis redis-cli XINFO GROUPS telemetry:inbound

# 7. DLQ issues?
docker exec pulse-redis redis-cli LLEN telemetry_errors

# 8. Data reaching DB?
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT COUNT(*) FROM telemetry WHERE recorded_at > NOW() - INTERVAL '5 minutes';"
```

---

## Startup Issues

### Container fails to start — "port already in use"

**Symptom:** `Bind for 0.0.0.0:XXXX failed: port is already allocated`

**Fix:**
```bash
# Find what's using the port (e.g., 5432)
# On Linux/Mac:
lsof -i :5432
# On Windows:
netstat -ano | findstr :5432

# Option 1: Stop the conflicting service
# Option 2: Change the port mapping in docker-compose.yml
```

### TimescaleDB fails with "database already exists"

**Symptom:** Init script errors on restart.

**This is normal.** The `init-db.sql` uses `IF NOT EXISTS` guards. PostgreSQL only runs scripts in `/docker-entrypoint-initdb.d/` on first initialization (when the data directory is empty).

### Ingestor exits immediately

**Symptom:** Container exits with code 1 right after start.

**Check:**
```bash
docker compose logs ingestor
```

**Common causes:**
- Redis not ready yet — check `depends_on` health check
- Missing environment variables — verify `.env` file exists
- Port conflict on 8085 or 9100

### Processor exits with connection refused

**Symptom:** `Connection refused` to Redis or TimescaleDB.

**Fix:** Ensure infrastructure services are healthy before processor starts:
```bash
# Check health status
docker compose ps

# If health checks aren't passing, check logs
docker compose logs redis
docker compose logs timescaledb
```

---

## Ingestion Issues

### Sensors can't connect to WebSocket

**Symptom:** `WebSocket connection to 'ws://localhost:8085' failed`

**Checks:**
```bash
# Is the ingestor running?
docker compose ps ingestor

# Is port 8085 listening?
docker compose logs ingestor | grep "listening"

# Test connection
# Using websocat:
echo '{"sensorId":"test","metricType":"temperature","value":50}' | websocat ws://localhost:8085

# Using JavaScript:
node -e "const ws = new (require('ws'))('ws://localhost:8085'); ws.on('open', () => { console.log('Connected!'); ws.close(); }); ws.on('error', e => console.error(e.message));"
```

**Common causes:**
- Ingestor container not running
- Firewall blocking port 8085
- Docker network issue — try `docker compose restart ingestor`

### Events sent but not reaching Redis

**Symptom:** WebSocket ACKs received, but `XLEN telemetry:inbound` stays at 0.

**Checks:**
```bash
# Check ingestor logs for Redis errors
docker compose logs ingestor | grep -i "error\|redis"

# Check Redis connectivity from ingestor
docker exec pulse-ingestor sh -c "nc -z redis 6379 && echo 'OK' || echo 'FAIL'"

# Check ingestor metrics
curl http://localhost:9100/metrics | grep pulse_redis_pushes_total
```

**Common causes:**
- Redis host resolution failure (check `REDIS_HOST` env var)
- Micro-batch buffer not flushing (events < 200 and timer not firing)
- Redis pipeline errors (check logs for XADD failures)

### "Invalid JSON payload" errors

**Symptom:** Sensor receives error responses instead of ACKs.

**Fix:** Ensure payloads match the required format:
```json
{
  "sensorId": "string (required)",
  "metricType": "string (required)",
  "value": "number - finite (required)",
  "unit": "string (optional)",
  "timestamp": "ISO-8601 string (optional)",
  "metadata": "object (optional)"
}
```

Validation rules:
- `sensorId` — must be a non-empty string
- `metricType` — must be a non-empty string
- `value` — must be a finite number (not `NaN`, not `Infinity`)

---

## Processing Issues

### Events queuing in Redis but not being processed

**Symptom:** `XLEN telemetry:inbound` growing, but `pulse_events_processed_total` not increasing.

**Checks:**
```bash
# Is processor running?
docker compose ps processor

# Check processor logs
docker compose logs processor | tail -50

# Check consumer group
docker exec pulse-redis redis-cli XINFO GROUPS telemetry:inbound

# Check pending entries
docker exec pulse-redis redis-cli XPENDING telemetry:inbound pulse-processors
```

**Common causes:**
- Processor crashed — check logs and restart
- Consumer group not created — processor creates it automatically on start
- TimescaleDB connection failure blocking the pipeline — check DB health

### High DLQ count

**Symptom:** `pulse_dlq_length` > 0 and growing.

**Investigate:**
```bash
# View latest DLQ entries
docker exec pulse-redis redis-cli LRANGE telemetry_errors 0 4

# Parse and inspect
docker exec pulse-redis redis-cli LINDEX telemetry_errors 0
```

**Common causes:**
- Sensor sending malformed data (missing fields, non-numeric values)
- Schema mismatch between ingestor and processor expectations
- Encoding issues in metadata JSON

### Alerts not generating

**Symptom:** Sensors clearly above threshold, but no alerts in dashboard.

**Checks:**
```bash
# Check threshold configuration
docker compose exec processor printenv | grep ALERT_

# Check cooldown — is this sensor in cooldown?
# (Alert cooldown is 30 seconds per sensor)
docker compose logs processor | grep "alert\|threshold"

# Check alerts table
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT 5;"
```

**Common causes:**
- 30-second cooldown active for the sensor (wait 30s, try again)
- Threshold misconfigured in environment variables
- Value is below the configured threshold (double-check units)

### "Connection refused" to TimescaleDB

**Symptom:** Processor logs show `Npgsql.NpgsqlException: Connection refused`

**Checks:**
```bash
# Is TimescaleDB running and healthy?
docker compose ps timescaledb
docker exec pulse-timescaledb pg_isready -U pulse_admin -d pulseengine

# Check connection string components
docker compose exec processor printenv | grep POSTGRES_

# Test direct connection
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine -c "SELECT 1;"
```

**Fix:** If TimescaleDB just restarted, wait for health check to pass. The processor will retry automatically.

---

## Database Issues

### "relation telemetry does not exist"

**Symptom:** Processor fails with relation error.

**Cause:** `init-db.sql` didn't run during database initialization.

**Fix:**
```bash
# Option 1: Run init script manually
docker exec -i pulse-timescaledb psql -U pulse_admin -d pulseengine < infrastructure/init-db.sql

# Option 2: Clean restart (destroys data)
docker compose down -v
docker compose up --build
```

### Database running out of disk space

**Symptom:** Insert failures, "No space left on device" errors.

**Checks:**
```bash
# Check table sizes
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT hypertable_size('telemetry');"

# Check compression status
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT * FROM hypertable_compression_stats('telemetry');"

# Check chunk info
docker exec pulse-timescaledb psql -U pulse_admin -d pulseengine \
  -c "SELECT * FROM timescaledb_information.chunks WHERE hypertable_name = 'telemetry' ORDER BY range_start DESC LIMIT 10;"
```

**Fix:**
```sql
-- Force compression on all uncompressed chunks older than 1 hour
SELECT compress_chunk(c.chunk_name)
FROM timescaledb_information.chunks c
WHERE c.hypertable_name = 'telemetry'
  AND NOT c.is_compressed
  AND c.range_end < NOW() - INTERVAL '1 hour';

-- Manually drop old data
SELECT drop_chunks('telemetry', older_than => INTERVAL '7 days');
```

### Slow queries on telemetry table

**Fix:** Ensure indexes exist:
```sql
-- Check existing indexes
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'telemetry';

-- Recreate if missing
CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_time
    ON telemetry (sensor_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_metric_type
    ON telemetry (metric_type, recorded_at DESC);
```

---

## Dashboard Issues

### Dashboard shows "Disconnected" / no data

**Symptom:** Dashboard loads but shows no telemetry data.

**Checks:**
```bash
# Is processor running with SignalR hub?
docker compose ps processor
curl http://localhost:5050/hub/telemetry  # Should get a response (not 404)

# Check SignalR connections metric
curl -s http://localhost:5050/metrics | grep pulse_signalr_connections

# Check browser console for WebSocket errors
# (open browser dev tools → Console tab)
```

**Common causes:**
- Processor not running — restart it
- Nginx not proxying `/hub/*` — check `frontend/nginx.conf`
- CORS issue — check browser console for CORS errors
- SignalR negotiation failing — check browser Network tab for `/hub/telemetry/negotiate`

### Dashboard loads but charts are empty

**Symptom:** Dashboard connected, but charts show no data points.

**Checks:**
- Is the simulator running? `docker compose ps simulator`
- Is data flowing through Redis? `docker exec pulse-redis redis-cli XLEN telemetry:inbound`
- Check browser console for JavaScript errors

**Common causes:**
- Simulator not connected to ingestor
- Processor not broadcasting via SignalR
- Frontend receiving data but store not updating (JavaScript error)

### Alerts not appearing in LiveAlertFeed

**Symptom:** SensorCards turn red but no alerts in the feed.

**Check:** Browser console for `ReceiveAlert` events. The alert feed maxes at 100 entries — older alerts are removed.

---

## Redis Issues

### Redis out of memory

**Symptom:** `OOM command not allowed when used memory > 'maxmemory'`

**Fix:**
```bash
# Check memory usage
docker exec pulse-redis redis-cli INFO memory | grep used_memory_human

# Check stream size
docker exec pulse-redis redis-cli XLEN telemetry:inbound
docker exec pulse-redis redis-cli MEMORY USAGE telemetry:inbound

# Manual trim if stream is too large
docker exec pulse-redis redis-cli XTRIM telemetry:inbound MAXLEN ~ 500000
```

**Prevention:** The ingestor already uses `MAXLEN ~ 1000000` on XADD, but if the processor is down, the stream can grow. Increase Redis `maxmemory` or ensure processor stays running.

### Consumer group "NOGROUP"

**Symptom:** `NOGROUP No such key 'telemetry:inbound' or consumer group 'pulse-processors'`

**Cause:** Stream or consumer group doesn't exist (clean Redis start, no data yet).

**Fix:** The processor auto-creates the consumer group on startup. If the stream doesn't exist yet:
```bash
# Create stream with a dummy entry (then delete it)
docker exec pulse-redis redis-cli XADD telemetry:inbound '*' init true
docker exec pulse-redis redis-cli XGROUP CREATE telemetry:inbound pulse-processors '$' MKSTREAM
```

Or simply start the simulator — it will create the stream by sending data.

---

## Monitoring Issues

### Prometheus shows "target down"

**Symptom:** Prometheus targets page shows one or more targets as DOWN.

**Checks:**
```bash
# Check Prometheus targets
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool

# Verify metrics endpoints directly
curl http://localhost:9100/metrics  # Ingestor
curl http://localhost:5050/metrics  # Processor
```

**Common causes:**
- Service not running — `docker compose ps`
- Metrics endpoint not accessible from Prometheus container — check Docker network
- Wrong port in `prometheus.yml`

### Grafana shows "No Data" in panels

**Checks:**
1. Is the Prometheus data source configured? **Configuration** → **Data Sources** → **Prometheus**
2. Is Prometheus collecting data? Check http://localhost:9090/targets
3. Test a PromQL query directly in Prometheus: http://localhost:9090/graph → query `up`

**Fix:** If data source is missing, it should auto-provision. Try:
```bash
docker compose restart grafana
```

### Grafana dashboard missing

**Symptom:** No "PulseEngine Health" dashboard in Grafana.

**Fix:**
```bash
# Check provisioning files
ls infrastructure/grafana/provisioning/dashboards/
ls infrastructure/grafana/dashboards/

# Restart Grafana to re-provision
docker compose restart grafana

# Check Grafana logs for provisioning errors
docker compose logs grafana | grep -i "provision\|error"
```

---

## Performance Issues

### High event loop lag in ingestor

**Symptom:** `nodejs_eventloop_lag_seconds > 0.1`

**Causes & Fixes:**
- **Too many connections:** Reduce `INGESTOR_MAX_CONNECTIONS` or scale horizontally
- **Large payloads:** Ensure sensors aren't sending oversized metadata
- **GC pressure:** Check `nodejs_gc_duration_seconds` — if GC pauses are long, increase Node.js heap (`--max-old-space-size`)

### Processor can't keep up with ingestion rate

**Symptom:** Redis stream length growing continuously (`XLEN` increasing).

**Fixes:**
1. **Increase batch size:** Set `PROCESSOR_BATCH_SIZE=200` (processes more events per cycle)
2. **Scale horizontally:** Add `processor-2` instance to the consumer group
3. **Check DB writes:** If `pulse_db_write_duration_seconds` is high, the database is the bottleneck
4. **Check network:** Verify latency between processor and TimescaleDB containers

### Dashboard lagging / not updating

**Symptom:** Dashboard data is stale or updates in bursts.

**Checks:**
- Browser performance: Check CPU usage in browser dev tools
- SignalR connection: Check for reconnection messages in browser console
- Processor broadcasting: Check `pulse_signalr_connections` metric (should be ≥ 1)

---

## Docker Issues

### "no space left on device" during build

```bash
# Clean up unused Docker resources
docker system prune -a --volumes

# Remove dangling images
docker image prune -a

# Check disk usage
docker system df
```

### Container keeps restarting

```bash
# Check exit code
docker compose ps

# Check logs for the crash
docker compose logs --tail=50 <service-name>

# Common exit codes:
# 0  = Clean exit
# 1  = Application error (check logs)
# 137 = OOM killed (increase memory limits)
# 143 = SIGTERM (graceful shutdown)
```

### Network connectivity between containers

```bash
# Test connectivity from one container to another
docker exec pulse-ingestor sh -c "nc -z redis 6379 && echo OK || echo FAIL"
docker exec pulse-processor sh -c "nc -z timescaledb 5432 && echo OK || echo FAIL"
docker exec pulse-processor sh -c "nc -z redis 6379 && echo OK || echo FAIL"

# Check Docker network
docker network ls
docker network inspect pulseengine_default
```

### Rebuilding a single service

```bash
# Rebuild and restart just one service (doesn't affect others)
docker compose up --build -d processor

# Force full rebuild (no cache)
docker compose build --no-cache processor
docker compose up -d processor
```

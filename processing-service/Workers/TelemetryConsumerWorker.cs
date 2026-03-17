using Microsoft.AspNetCore.SignalR;
using Prometheus;
using StackExchange.Redis;
using PulseEngine.Processor.Hubs;
using PulseEngine.Processor.Models;
using PulseEngine.Processor.Services;

namespace PulseEngine.Processor.Workers;

/// <summary>
/// Background worker that consumes telemetry events from Redis Streams
/// using a consumer group, processes threshold alerts, persists to TimescaleDB,
/// and pushes real-time updates to the dashboard via SignalR.
/// </summary>
public sealed class TelemetryConsumerWorker : BackgroundService
{
    private readonly ILogger<TelemetryConsumerWorker> _logger;
    private readonly TimescaleDbService _db;
    private readonly ThresholdAlertService _alertService;
    private readonly DeadLetterService _dlq;
    private readonly ConnectionMultiplexer _redis;
    private readonly IHubContext<TelemetryHub> _hub;
    private readonly string _streamKey;
    private readonly string _groupName;
    private readonly string _consumerName;
    private readonly int _batchSize;
    private readonly int _blockMs;

    // ── Prometheus Metrics ─────────────────────────────────
    private static readonly Counter EventsProcessedTotal = Metrics
        .CreateCounter("pulse_events_processed_total",
            "Total telemetry events successfully processed");

    private static readonly Histogram BatchSizeHistogram = Metrics
        .CreateHistogram("pulse_batch_size",
            "Number of events per processing batch",
            new HistogramConfiguration
            {
                Buckets = Histogram.LinearBuckets(start: 10, width: 10, count: 10)
            });

    private static readonly Histogram ProcessingDuration = Metrics
        .CreateHistogram("pulse_processing_duration_seconds",
            "Time to process a complete batch (parse + evaluate + persist + broadcast)",
            new HistogramConfiguration
            {
                Buckets = Histogram.ExponentialBuckets(start: 0.001, factor: 2, count: 12)
            });

    private static readonly Counter AlertsGeneratedTotal = Metrics
        .CreateCounter("pulse_alerts_generated_total",
            "Total threshold alerts generated");

    private static readonly Histogram DbWriteDuration = Metrics
        .CreateHistogram("pulse_db_write_duration_seconds",
            "Time to persist a batch to TimescaleDB via COPY",
            new HistogramConfiguration
            {
                Buckets = Histogram.ExponentialBuckets(start: 0.001, factor: 2, count: 10)
            });

    private static readonly Counter DlqMessagesTotal = Metrics
        .CreateCounter("pulse_dlq_messages_total",
            "Total messages sent to the dead letter queue");

    private static readonly Gauge DlqLength = Metrics
        .CreateGauge("pulse_dlq_length",
            "Current length of the dead letter queue in Redis");

    public TelemetryConsumerWorker(
        ILogger<TelemetryConsumerWorker> logger,
        TimescaleDbService db,
        ThresholdAlertService alertService,
        DeadLetterService dlq,
        ConnectionMultiplexer redis,
        IHubContext<TelemetryHub> hub,
        string streamKey,
        string groupName,
        string consumerName,
        int batchSize,
        int blockMs)
    {
        _logger = logger;
        _db = db;
        _alertService = alertService;
        _dlq = dlq;
        _redis = redis;
        _hub = hub;
        _streamKey = streamKey;
        _groupName = groupName;
        _consumerName = consumerName;
        _batchSize = batchSize;
        _blockMs = blockMs;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var db = _redis.GetDatabase();

        // Ensure consumer group exists (MKSTREAM creates the stream if absent)
        try
        {
            await db.StreamCreateConsumerGroupAsync(
                _streamKey, _groupName, "0-0", createStream: true);
            _logger.LogInformation("Created consumer group '{Group}' on '{Stream}'",
                _groupName, _streamKey);
        }
        catch (RedisServerException ex) when (ex.Message.Contains("BUSYGROUP"))
        {
            _logger.LogInformation("Consumer group '{Group}' already exists", _groupName);
        }

        _logger.LogInformation(
            "Starting consumption: stream={Stream}, group={Group}, consumer={Consumer}, batch={Batch}",
            _streamKey, _groupName, _consumerName, _batchSize);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var entries = await db.StreamReadGroupAsync(
                    _streamKey,
                    _groupName,
                    _consumerName,
                    position: ">",
                    count: _batchSize,
                    noAck: false
                );

                if (entries.Length == 0)
                {
                    await Task.Delay(_blockMs, stoppingToken);
                    continue;
                }

                // ── Parse stream entries into domain models ──
                var events = new List<TelemetryEvent>(entries.Length);
                var entryFieldsMap = new Dictionary<string, Dictionary<string, string>>();

                foreach (var entry in entries)
                {
                    var fields = entry.Values.ToDictionary(
                        v => v.Name.ToString(),
                        v => v.Value.ToString());

                    entryFieldsMap[entry.Id.ToString()] = fields;

                    if (!fields.TryGetValue("sensorId", out var sensorId) ||
                        !fields.TryGetValue("metricType", out var metricType) ||
                        !fields.TryGetValue("value", out var valueStr) ||
                        !double.TryParse(valueStr, out var value))
                    {
                        // ── DLQ: malformed entry ───────────────────
                        var reason = !fields.ContainsKey("sensorId") ? "Missing sensorId"
                            : !fields.ContainsKey("metricType") ? "Missing metricType"
                            : !fields.ContainsKey("value") ? "Missing value"
                            : $"Unparseable value: '{fields.GetValueOrDefault("value")}'";

                        await _dlq.PushAsync(entry.Id.ToString(), fields, reason);
                        DlqMessagesTotal.Inc();
                        continue;
                    }

                    fields.TryGetValue("timestamp", out var timestamp);
                    fields.TryGetValue("unit", out var unit);
                    fields.TryGetValue("metadata", out var metadata);

                    events.Add(new TelemetryEvent
                    {
                        SensorId = sensorId,
                        MetricType = metricType,
                        Value = value,
                        Unit = unit,
                        Timestamp = DateTimeOffset.TryParse(timestamp, out var ts)
                            ? ts
                            : DateTimeOffset.UtcNow,
                        Metadata = metadata
                    });
                }

                if (events.Count == 0)
                {
                    // All entries were malformed — ACK and move on
                    foreach (var entry in entries)
                        await db.StreamAcknowledgeAsync(_streamKey, _groupName, entry.Id);
                    continue;
                }

                BatchSizeHistogram.Observe(events.Count);

                // ── Process batch (with Prometheus timing) ─────
                using (ProcessingDuration.NewTimer())
                {
                    // ── Threshold evaluation ─────────────────────
                    var alerts = _alertService.Evaluate(events);
                    if (alerts.Count > 0)
                    {
                        _logger.LogWarning("{Count} threshold alerts triggered", alerts.Count);
                        AlertsGeneratedTotal.Inc(alerts.Count);
                    }

                    // ── Persist to TimescaleDB ───────────────────
                    using (DbWriteDuration.NewTimer())
                    {
                        await _db.InsertTelemetryBatchAsync(events);
                        if (alerts.Count > 0)
                            await _db.InsertAlertsAsync(alerts);
                    }

                    // ── Push to SignalR (real-time dashboard) ────
                    await _hub.Clients.All.SendAsync(
                        "ReceiveTelemetryBatch",
                        events.Select(e => new
                        {
                            e.SensorId,
                            e.MetricType,
                            e.Value,
                            e.Unit,
                            Timestamp = e.Timestamp.ToString("o")
                        }),
                        stoppingToken
                    );

                    foreach (var alert in alerts)
                    {
                        await _hub.Clients.All.SendAsync(
                            "ReceiveAlert",
                            new
                            {
                                Id = Guid.NewGuid().ToString(),
                                alert.SensorId,
                                alert.MetricType,
                                alert.ThresholdValue,
                                alert.ActualValue,
                                alert.Severity,
                                alert.Message,
                                TriggeredAt = alert.TriggeredAt.ToString("o")
                            },
                            stoppingToken
                        );
                    }

                    _logger.LogInformation(
                        "Processed {Events} events, {Alerts} alerts → pushed to SignalR",
                        events.Count, alerts.Count);
                }

                // ── ACK all processed entries ────────────────
                foreach (var entry in entries)
                {
                    await db.StreamAcknowledgeAsync(_streamKey, _groupName, entry.Id);
                }

                EventsProcessedTotal.Inc(events.Count);

                // ── Update DLQ gauge ─────────────────────────
                try { DlqLength.Set(await _dlq.GetLengthAsync()); } catch { /* non-critical */ }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing telemetry batch");
                await Task.Delay(1000, stoppingToken);
            }
        }

        _logger.LogInformation("Consumer worker stopped");
    }
}

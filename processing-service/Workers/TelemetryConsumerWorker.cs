using Microsoft.AspNetCore.SignalR;
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
    private readonly ConnectionMultiplexer _redis;
    private readonly IHubContext<TelemetryHub> _hub;
    private readonly string _streamKey;
    private readonly string _groupName;
    private readonly string _consumerName;
    private readonly int _batchSize;
    private readonly int _blockMs;

    public TelemetryConsumerWorker(
        ILogger<TelemetryConsumerWorker> logger,
        TimescaleDbService db,
        ThresholdAlertService alertService,
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
                foreach (var entry in entries)
                {
                    var fields = entry.Values.ToDictionary(
                        v => v.Name.ToString(),
                        v => v.Value.ToString());

                    if (!fields.TryGetValue("sensorId", out var sensorId) ||
                        !fields.TryGetValue("metricType", out var metricType) ||
                        !fields.TryGetValue("value", out var valueStr) ||
                        !double.TryParse(valueStr, out var value))
                    {
                        _logger.LogWarning("Skipping malformed entry {Id}", entry.Id);
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

                // ── Threshold evaluation ─────────────────────
                var alerts = _alertService.Evaluate(events);
                if (alerts.Count > 0)
                {
                    _logger.LogWarning("{Count} threshold alerts triggered", alerts.Count);
                }

                // ── Persist to TimescaleDB ───────────────────
                await _db.InsertTelemetryBatchAsync(events);

                if (alerts.Count > 0)
                {
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

                // ── ACK all processed entries ────────────────
                foreach (var entry in entries)
                {
                    await db.StreamAcknowledgeAsync(_streamKey, _groupName, entry.Id);
                }

                _logger.LogInformation(
                    "Processed {Events} events, {Alerts} alerts → pushed to SignalR",
                    events.Count, alerts.Count);
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

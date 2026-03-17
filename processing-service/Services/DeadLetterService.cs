using System.Text.Json;
using StackExchange.Redis;

namespace PulseEngine.Processor.Services;

/// <summary>
/// Routes malformed or failed telemetry entries to a Redis-backed
/// dead letter queue (telemetry_errors) for inspection and replay.
/// </summary>
public sealed class DeadLetterService
{
    private readonly IDatabase _db;
    private readonly ILogger<DeadLetterService> _logger;
    private const string DlqKey = "telemetry_errors";

    public DeadLetterService(ConnectionMultiplexer redis, ILogger<DeadLetterService> logger)
    {
        _db = redis.GetDatabase();
        _logger = logger;
    }

    /// <summary>
    /// Push a malformed entry to the DLQ (e.g., missing fields, unparseable value).
    /// </summary>
    public async Task PushAsync(string streamEntryId, Dictionary<string, string> rawFields, string errorReason)
    {
        var dlqEntry = new
        {
            StreamEntryId = streamEntryId,
            RawData = rawFields,
            ErrorReason = errorReason,
            Timestamp = DateTimeOffset.UtcNow.ToString("o"),
            Source = "TelemetryConsumerWorker"
        };

        var json = JsonSerializer.Serialize(dlqEntry);
        await _db.ListLeftPushAsync(DlqKey, json);

        _logger.LogWarning("DLQ: Entry {EntryId} → {Reason}", streamEntryId, errorReason);
    }

    /// <summary>
    /// Push a processing failure (DB write error, etc.) to the DLQ.
    /// </summary>
    public async Task PushProcessingErrorAsync(
        string streamEntryId,
        Dictionary<string, string> rawFields,
        Exception exception)
    {
        var dlqEntry = new
        {
            StreamEntryId = streamEntryId,
            RawData = rawFields,
            ErrorReason = $"Processing error: {exception.Message}",
            ExceptionType = exception.GetType().FullName,
            Timestamp = DateTimeOffset.UtcNow.ToString("o"),
            Source = "TelemetryConsumerWorker"
        };

        var json = JsonSerializer.Serialize(dlqEntry);
        await _db.ListLeftPushAsync(DlqKey, json);

        _logger.LogWarning("DLQ: Entry {EntryId} → Processing error: {Error}",
            streamEntryId, exception.Message);
    }

    /// <summary>
    /// Get the current DLQ length (for Prometheus gauge).
    /// </summary>
    public async Task<long> GetLengthAsync()
    {
        return await _db.ListLengthAsync(DlqKey);
    }
}

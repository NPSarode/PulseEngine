using Npgsql;
using PulseEngine.Processor.Models;

namespace PulseEngine.Processor.Services;

/// <summary>
/// Handles batch persistence of telemetry events and alerts to TimescaleDB.
/// Uses Npgsql binary COPY for maximum insert throughput.
/// </summary>
public sealed class TimescaleDbService : IAsyncDisposable
{
    private readonly string _connectionString;
    private NpgsqlDataSource? _dataSource;

    public TimescaleDbService(string host, int port, string database, string user, string password)
    {
        _connectionString = $"Host={host};Port={port};Database={database};Username={user};Password={password};Pooling=true;Minimum Pool Size=2;Maximum Pool Size=20";
    }

    public async Task InitializeAsync()
    {
        _dataSource = NpgsqlDataSource.Create(_connectionString);

        // Verify connectivity
        await using var conn = await _dataSource.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1";
        await cmd.ExecuteScalarAsync();

        Console.WriteLine("[TimescaleDB] Connected and verified");
    }

    /// <summary>
    /// Batch-insert telemetry events using COPY for high throughput.
    /// At 10k+ events/sec, row-by-row INSERT would be a bottleneck.
    /// </summary>
    public async Task InsertTelemetryBatchAsync(IReadOnlyList<TelemetryEvent> events)
    {
        if (events.Count == 0) return;

        await using var conn = await _dataSource!.OpenConnectionAsync();
        await using var writer = await conn.BeginBinaryImportAsync(
            "COPY telemetry (sensor_id, metric_type, value, unit, recorded_at, metadata) FROM STDIN (FORMAT BINARY)"
        );

        foreach (var evt in events)
        {
            await writer.StartRowAsync();
            await writer.WriteAsync(evt.SensorId, NpgsqlTypes.NpgsqlDbType.Varchar);
            await writer.WriteAsync(evt.MetricType, NpgsqlTypes.NpgsqlDbType.Varchar);
            await writer.WriteAsync(evt.Value, NpgsqlTypes.NpgsqlDbType.Double);

            if (evt.Unit is not null)
                await writer.WriteAsync(evt.Unit, NpgsqlTypes.NpgsqlDbType.Varchar);
            else
                await writer.WriteNullAsync();

            await writer.WriteAsync(evt.Timestamp, NpgsqlTypes.NpgsqlDbType.TimestampTz);

            if (evt.Metadata is not null)
                await writer.WriteAsync(evt.Metadata, NpgsqlTypes.NpgsqlDbType.Jsonb);
            else
                await writer.WriteNullAsync();
        }

        await writer.CompleteAsync();
    }

    /// <summary>
    /// Insert threshold alerts for the alerting pipeline.
    /// </summary>
    public async Task InsertAlertsAsync(IReadOnlyList<ThresholdAlert> alerts)
    {
        if (alerts.Count == 0) return;

        await using var conn = await _dataSource!.OpenConnectionAsync();

        foreach (var alert in alerts)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO alerts (sensor_id, metric_type, threshold_value, actual_value, severity, message, triggered_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """;
            cmd.Parameters.AddWithValue(alert.SensorId);
            cmd.Parameters.AddWithValue(alert.MetricType);
            cmd.Parameters.AddWithValue(alert.ThresholdValue);
            cmd.Parameters.AddWithValue(alert.ActualValue);
            cmd.Parameters.AddWithValue(alert.Severity);
            cmd.Parameters.AddWithValue(alert.Message ?? (object)DBNull.Value);
            cmd.Parameters.AddWithValue(alert.TriggeredAt);
            await cmd.ExecuteNonQueryAsync();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_dataSource is not null)
            await _dataSource.DisposeAsync();
    }
}

namespace PulseEngine.Processor.Models;

/// <summary>
/// Represents a single IoT telemetry signal flowing through PulseEngine.
/// Maps directly to the Redis Stream fields and the TimescaleDB telemetry table.
/// </summary>
public sealed class TelemetryEvent
{
    public required string SensorId { get; init; }
    public required string MetricType { get; init; }
    public required double Value { get; init; }
    public string? Unit { get; init; }
    public required DateTimeOffset Timestamp { get; init; }
    public string? Metadata { get; init; }
}

/// <summary>
/// Threshold alert generated when a telemetry value exceeds configured bounds.
/// </summary>
public sealed class ThresholdAlert
{
    public required string SensorId { get; init; }
    public required string MetricType { get; init; }
    public required double ThresholdValue { get; init; }
    public required double ActualValue { get; init; }
    public string Severity { get; init; } = "WARNING";
    public string? Message { get; init; }
    public DateTimeOffset TriggeredAt { get; init; } = DateTimeOffset.UtcNow;
}

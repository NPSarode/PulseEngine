using PulseEngine.Processor.Models;

namespace PulseEngine.Processor.Services;

/// <summary>
/// Evaluates telemetry events against configurable thresholds.
/// Generates ThresholdAlerts when values exceed bounds.
/// </summary>
public sealed class ThresholdAlertService
{
    private readonly Dictionary<string, (double? Low, double? High)> _thresholds = new();
    private readonly Dictionary<string, DateTime> _cooldowns = new();
    private static readonly TimeSpan CooldownPeriod = TimeSpan.FromSeconds(30);

    public ThresholdAlertService()
    {
        // Load thresholds from environment
        RegisterFromEnv("temperature", "ALERT_TEMPERATURE_LOW", "ALERT_TEMPERATURE_HIGH");
        RegisterFromEnv("pressure", null, "ALERT_PRESSURE_HIGH");
        RegisterFromEnv("humidity", null, "ALERT_HUMIDITY_HIGH");
    }

    private void RegisterFromEnv(string metricType, string? lowEnvVar, string? highEnvVar)
    {
        double? low = lowEnvVar is not null && double.TryParse(
            Environment.GetEnvironmentVariable(lowEnvVar), out var l) ? l : null;
        double? high = highEnvVar is not null && double.TryParse(
            Environment.GetEnvironmentVariable(highEnvVar), out var h) ? h : null;

        if (low.HasValue || high.HasValue)
        {
            _thresholds[metricType.ToLowerInvariant()] = (low, high);
            Console.WriteLine($"[Alerts] {metricType}: low={low?.ToString() ?? "none"}, high={high?.ToString() ?? "none"}");
        }
    }

    /// <summary>
    /// Evaluate a batch of events, returning any threshold violations.
    /// </summary>
    public List<ThresholdAlert> Evaluate(IReadOnlyList<TelemetryEvent> events)
    {
        var alerts = new List<ThresholdAlert>();

        var now = DateTime.UtcNow;

        foreach (var evt in events)
        {
            if (!_thresholds.TryGetValue(evt.MetricType.ToLowerInvariant(), out var bounds))
                continue;

            // Skip if this sensor is still in cooldown
            if (_cooldowns.TryGetValue(evt.SensorId, out var lastAlert) && now - lastAlert < CooldownPeriod)
                continue;

            if (bounds.High.HasValue && evt.Value > bounds.High.Value)
            {
                _cooldowns[evt.SensorId] = now;
                alerts.Add(new ThresholdAlert
                {
                    SensorId = evt.SensorId,
                    MetricType = evt.MetricType,
                    ThresholdValue = bounds.High.Value,
                    ActualValue = evt.Value,
                    Severity = "CRITICAL",
                    Message = $"{evt.MetricType} value {evt.Value:F1} exceeds upper threshold {bounds.High.Value}"
                });
            }
            else if (bounds.Low.HasValue && evt.Value < bounds.Low.Value)
            {
                _cooldowns[evt.SensorId] = now;
                alerts.Add(new ThresholdAlert
                {
                    SensorId = evt.SensorId,
                    MetricType = evt.MetricType,
                    ThresholdValue = bounds.Low.Value,
                    ActualValue = evt.Value,
                    Severity = "CRITICAL",
                    Message = $"{evt.MetricType} value {evt.Value:F1} below lower threshold {bounds.Low.Value}"
                });
            }
        }

        return alerts;
    }
}

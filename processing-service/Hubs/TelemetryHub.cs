using Microsoft.AspNetCore.SignalR;
using Prometheus;

namespace PulseEngine.Processor.Hubs;

/// <summary>
/// SignalR Hub for real-time telemetry streaming to the dashboard.
/// The .NET worker pushes events here; connected browsers receive them instantly.
/// </summary>
public sealed class TelemetryHub : Hub
{
    private readonly ILogger<TelemetryHub> _logger;

    private static readonly Gauge SignalrConnections = Metrics
        .CreateGauge("pulse_signalr_connections",
            "Number of active SignalR dashboard connections");

    public TelemetryHub(ILogger<TelemetryHub> logger)
    {
        _logger = logger;
    }

    public override Task OnConnectedAsync()
    {
        SignalrConnections.Inc();
        _logger.LogInformation("Dashboard client connected: {Id}", Context.ConnectionId);
        return base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        SignalrConnections.Dec();
        _logger.LogInformation("Dashboard client disconnected: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }
}

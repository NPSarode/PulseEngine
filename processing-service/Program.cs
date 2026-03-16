using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;
using PulseEngine.Processor.Hubs;
using PulseEngine.Processor.Services;
using PulseEngine.Processor.Workers;

// ─── Configuration ───────────────────────────────────────
var redisHost    = Environment.GetEnvironmentVariable("REDIS_HOST") ?? "localhost";
var redisPort    = int.Parse(Environment.GetEnvironmentVariable("REDIS_PORT") ?? "6379");
var streamKey    = Environment.GetEnvironmentVariable("REDIS_STREAM_KEY") ?? "telemetry:inbound";
var groupName    = Environment.GetEnvironmentVariable("CONSUMER_GROUP") ?? "pulse-processors";
var consumerName = Environment.GetEnvironmentVariable("CONSUMER_NAME") ?? "processor-1";
var batchSize    = int.Parse(Environment.GetEnvironmentVariable("BATCH_SIZE") ?? "100");
var blockMs      = int.Parse(Environment.GetEnvironmentVariable("BLOCK_MS") ?? "2000");

var pgHost = Environment.GetEnvironmentVariable("POSTGRES_HOST") ?? "localhost";
var pgPort = int.Parse(Environment.GetEnvironmentVariable("POSTGRES_PORT") ?? "5432");
var pgDb   = Environment.GetEnvironmentVariable("POSTGRES_DB") ?? "pulseengine";
var pgUser = Environment.GetEnvironmentVariable("POSTGRES_USER") ?? "pulse_admin";
var pgPass = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD") ?? "";

Console.WriteLine("═══════════════════════════════════════════");
Console.WriteLine("  PulseEngine · Processing Service v1.0.0 ");
Console.WriteLine("═══════════════════════════════════════════");

// ─── Build Web App ───────────────────────────────────────
var builder = WebApplication.CreateBuilder(args);

// SignalR
builder.Services.AddSignalR();

// CORS — allow the frontend origin
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.SetIsOriginAllowed(_ => true)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

// Redis connection
var redis = await ConnectionMultiplexer.ConnectAsync($"{redisHost}:{redisPort}");
Console.WriteLine($"[Redis] Connected to {redisHost}:{redisPort}");

// TimescaleDB service
var dbService = new TimescaleDbService(pgHost, pgPort, pgDb, pgUser, pgPass);
await dbService.InitializeAsync();

// Threshold alert evaluator
var alertService = new ThresholdAlertService();

// Register the consumer worker
builder.Services.AddHostedService(sp =>
    new TelemetryConsumerWorker(
        sp.GetRequiredService<ILogger<TelemetryConsumerWorker>>(),
        dbService,
        alertService,
        redis,
        sp.GetRequiredService<IHubContext<TelemetryHub>>(),
        streamKey,
        groupName,
        consumerName,
        batchSize,
        blockMs
    )
);

var app = builder.Build();

app.UseCors();
app.MapHub<TelemetryHub>("/hub/telemetry");

// Kestrel listens on port 5050
app.Urls.Add("http://0.0.0.0:5050");

Console.WriteLine("[SignalR] Hub mapped at /hub/telemetry on port 5050");
await app.RunAsync();

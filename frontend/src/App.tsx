import { useSignalR } from "./hooks/useSignalR";
import { useTelemetryStore } from "./store/telemetryStore";
import { TelemetryChart } from "./components/charts/TelemetryChart";
import { SensorCard } from "./components/status/SensorCard";
import { GaugeRing } from "./components/status/GaugeRing";
import { LiveAlertFeed } from "./components/alerts/LiveAlertFeed";
import {
  Activity,
  Wifi,
  WifiOff,
  Zap,
  Radio,
  ShieldAlert,
  BarChart3,
} from "lucide-react";

export function App() {
  useSignalR();

  const { streams, sensors, alerts, connected, eventsPerSecond } =
    useTelemetryStore();

  const sensorList = Object.values(sensors);
  const chartEntries = Object.entries(streams).slice(0, 4);
  const gaugeMetrics = sensorList.slice(0, 4);
  const alertingSensors = sensorList.filter((s) => s.isAlert).length;

  return (
    <div className="min-h-screen bg-pulse-bg">
      {/* ═══ Header ═══════════════════════════════════════ */}
      <header className="border-b border-pulse-border bg-pulse-surface/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1680px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Left: Brand */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-pulse-accent to-blue-700 flex items-center justify-center shadow-lg shadow-blue-900/30">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-sm font-bold tracking-tight leading-none">
                PulseEngine
              </h1>
              <p className="text-[10px] text-pulse-muted leading-none mt-0.5">
                IoT Monitoring Dashboard
              </p>
            </div>
          </div>

          {/* Right: Stats + Status */}
          <div className="flex items-center gap-2 sm:gap-4">
            {/* Throughput */}
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pulse-bg text-xs">
              <Zap className="w-3 h-3 text-pulse-warning" />
              <span className="font-mono font-semibold tabular-nums text-gray-200">
                {eventsPerSecond.toLocaleString()}
              </span>
              <span className="text-pulse-muted">evt/s</span>
            </div>

            {/* Sensor count */}
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pulse-bg text-xs">
              <Radio className="w-3 h-3 text-pulse-accent" />
              <span className="font-mono font-semibold tabular-nums text-gray-200">
                {sensorList.length}
              </span>
              <span className="text-pulse-muted">sensors</span>
            </div>

            {/* Connection pill */}
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                connected
                  ? "bg-emerald-950/50 text-pulse-success border border-emerald-800/30"
                  : "bg-red-950/50 text-pulse-danger border border-red-800/30"
              }`}
            >
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span className="hidden sm:inline">
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ═══ Main Content ═════════════════════════════════ */}
      <main className="max-w-[1680px] mx-auto px-4 sm:px-6 py-5 space-y-5">

        {/* ─── Row 1: Stats Overview ──────────────────── */}
        <section>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
            {/* Gauges */}
            {gaugeMetrics.map((s) => (
              <div
                key={`gauge-${s.sensorId}`}
                className="card p-3 flex justify-center col-span-1"
              >
                <GaugeRing
                  value={s.latestValue}
                  min={0}
                  max={s.metricType === "temperature" ? 120 : s.metricType === "pressure" ? 200 : 100}
                  label={s.sensorId.split("-").slice(-1)[0]}
                  unit={s.unit}
                  thresholdHigh={
                    s.metricType === "temperature" ? 85
                    : s.metricType === "pressure" ? 150
                    : 95
                  }
                  size={120}
                />
              </div>
            ))}

            {/* Summary stat cards */}
            <StatCard
              icon={<Radio className="w-4 h-4" />}
              label="Active Sensors"
              value={sensorList.length}
              color="text-pulse-accent"
              iconBg="bg-blue-950/50"
            />
            <StatCard
              icon={<ShieldAlert className="w-4 h-4" />}
              label="Active Alerts"
              value={alerts.length}
              color={alerts.length > 0 ? "text-pulse-danger" : "text-pulse-success"}
              iconBg={alerts.length > 0 ? "bg-red-950/50" : "bg-emerald-950/50"}
            />
            <StatCard
              icon={<AlertTriangleIcon />}
              label="Alerting"
              value={alertingSensors}
              suffix={`/ ${sensorList.length}`}
              color={alertingSensors > 0 ? "text-pulse-warning" : "text-pulse-success"}
              iconBg={alertingSensors > 0 ? "bg-yellow-950/50" : "bg-emerald-950/50"}
            />
            <StatCard
              icon={<Zap className="w-4 h-4" />}
              label="Throughput"
              value={eventsPerSecond}
              suffix="/s"
              color="text-pulse-warning"
              iconBg="bg-yellow-950/50"
            />
          </div>
        </section>

        {/* ─── Row 2: Charts + Alerts ─────────────────── */}
        <section className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          {/* Charts */}
          <div className="xl:col-span-8 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 className="w-3.5 h-3.5 text-pulse-muted" />
              <h2 className="section-title mb-0">Real-time Telemetry</h2>
            </div>

            {chartEntries.length > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {chartEntries.map(([sensorId, data]) => {
                  const sensor = sensors[sensorId];
                  return (
                    <TelemetryChart
                      key={sensorId}
                      data={data}
                      sensorId={sensorId}
                      metricType={sensor?.metricType ?? "unknown"}
                      unit={sensor?.unit}
                      thresholdHigh={
                        sensor?.metricType === "temperature" ? 85
                        : sensor?.metricType === "pressure" ? 150
                        : undefined
                      }
                      thresholdLow={
                        sensor?.metricType === "temperature" ? -10 : undefined
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <div className="card p-16 text-center">
                <div className="w-16 h-16 rounded-full bg-pulse-bg mx-auto mb-4 flex items-center justify-center">
                  <Activity className="w-8 h-8 text-pulse-muted opacity-30" />
                </div>
                <p className="text-pulse-muted text-sm font-medium">
                  Waiting for telemetry data...
                </p>
                <p className="text-pulse-muted text-xs mt-1">
                  Connect sensors to ws://localhost:8085
                </p>
              </div>
            )}
          </div>

          {/* Alert Feed — fixed height, internally scrollable */}
          <div className="xl:col-span-4 h-[520px] xl:h-auto xl:max-h-[calc(100vh-160px)] xl:sticky xl:top-[72px]">
            <LiveAlertFeed />
          </div>
        </section>

        {/* ─── Row 3: Sensor Grid ─────────────────────── */}
        {sensorList.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-3.5 h-3.5 text-pulse-muted" />
              <h2 className="section-title mb-0">Sensor Overview</h2>
              <span className="text-[10px] text-pulse-muted bg-pulse-bg px-1.5 py-0.5 rounded ml-1">
                {sensorList.length} active
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {sensorList.map((sensor) => (
                <SensorCard key={sensor.sensorId} sensor={sensor} />
              ))}
            </div>
          </section>
        )}

        {/* Footer spacer */}
        <div className="h-4" />
      </main>
    </div>
  );
}

// ─── Stat Card Component ─────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  suffix,
  color,
  iconBg,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  suffix?: string;
  color: string;
  iconBg: string;
}) {
  return (
    <div className="card p-3.5 flex flex-col justify-between">
      <div className="flex items-center justify-between mb-2">
        <p className="stat-label">{label}</p>
        <div className={`p-1 rounded-md ${iconBg} ${color}`}>{icon}</div>
      </div>
      <p className={`stat-value ${color}`}>
        {value.toLocaleString()}
        {suffix && (
          <span className="text-xs font-normal text-pulse-muted ml-0.5 font-sans">
            {suffix}
          </span>
        )}
      </p>
    </div>
  );
}

function AlertTriangleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

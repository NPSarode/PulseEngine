import {
  Thermometer,
  Gauge,
  Droplets,
  Activity,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { SensorStatus } from "../../store/telemetryStore";

interface SensorCardProps {
  sensor: SensorStatus;
}

const METRIC_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  temperature: { icon: <Thermometer className="w-4 h-4" />, color: "#f59e0b" },
  pressure:    { icon: <Gauge className="w-4 h-4" />,       color: "#3b82f6" },
  humidity:    { icon: <Droplets className="w-4 h-4" />,     color: "#10b981" },
};
const DEFAULT_CONFIG = { icon: <Activity className="w-4 h-4" />, color: "#8b5cf6" };

function getTimeSince(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 3) return "live";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

export function SensorCard({ sensor }: SensorCardProps) {
  const isAlert = sensor.isAlert;
  const config = METRIC_CONFIG[sensor.metricType.toLowerCase()] ?? DEFAULT_CONFIG;

  return (
    <div
      className={`
        card-hover relative overflow-hidden p-3.5 group
        ${isAlert ? "!bg-red-950/30 !border-red-900/60 shadow-lg shadow-red-950/30" : ""}
      `}
    >
      {/* Alert ping */}
      {isAlert && (
        <div className="absolute top-2.5 right-2.5">
          <span className="absolute inline-flex h-2 w-2 rounded-full bg-pulse-danger opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-pulse-danger" />
        </div>
      )}

      {/* Row 1: Icon + ID + Time */}
      <div className="flex items-center gap-2 mb-2.5">
        <div
          className="p-1.5 rounded-lg"
          style={{
            backgroundColor: isAlert ? "rgba(239,68,68,0.15)" : `${config.color}15`,
            color: isAlert ? "#ef4444" : config.color,
          }}
        >
          {config.icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-200 truncate leading-tight">
            {sensor.sensorId}
          </p>
          <p className="text-[10px] text-pulse-muted capitalize">{sensor.metricType}</p>
        </div>
        <div className="flex items-center gap-0.5 text-[10px] text-pulse-muted self-start mt-0.5">
          <Clock className="w-2.5 h-2.5" />
          <span>{getTimeSince(sensor.lastUpdate)}</span>
        </div>
      </div>

      {/* Row 2: Value */}
      <div className="flex items-end justify-between mb-2.5">
        <p
          className={`stat-value leading-none ${isAlert ? "text-pulse-danger" : "text-gray-50"}`}
        >
          {sensor.latestValue.toFixed(1)}
          <span className="text-xs font-normal text-pulse-muted ml-1 font-sans">
            {sensor.unit ?? ""}
          </span>
        </p>

        {isAlert && (
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-900/30 text-pulse-danger">
            <AlertTriangle className="w-3 h-3" />
            <span className="text-[10px] font-semibold">ALERT</span>
          </div>
        )}
      </div>

      {/* Row 3: Status bar */}
      <div className="h-1 rounded-full bg-pulse-bg overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: isAlert ? "100%" : `${Math.min(80, Math.max(20, sensor.latestValue))}%`,
            backgroundColor: isAlert ? "#ef4444" : config.color,
            boxShadow: isAlert ? "0 0 8px rgba(239,68,68,0.4)" : "none",
          }}
        />
      </div>
    </div>
  );
}

import { useRef, useEffect, useState, useMemo } from "react";
import {
  AlertTriangle,
  AlertOctagon,
  ShieldAlert,
  CheckCircle2,
  CheckCheck,
  Filter,
} from "lucide-react";
import { Alert, useTelemetryStore } from "../../store/telemetryStore";

type FilterTab = "all" | "active" | "acknowledged";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function LiveAlertFeed() {
  const { alerts, acknowledgeAlert, acknowledgeAll } = useTelemetryStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<FilterTab>("all");
  const prevAlertCount = useRef(alerts.length);

  // Auto-scroll to top when new alerts arrive
  useEffect(() => {
    if (autoScroll && alerts.length > prevAlertCount.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
    prevAlertCount.current = alerts.length;
  }, [alerts.length, autoScroll]);

  // Detect manual scroll — pause auto-scroll if user scrolled down
  const handleScroll = () => {
    if (!scrollRef.current) return;
    setAutoScroll(scrollRef.current.scrollTop < 20);
  };

  // Filtered alerts
  const activeAlerts = useMemo(() => alerts.filter((a) => !a.acknowledged), [alerts]);
  const ackedAlerts = useMemo(() => alerts.filter((a) => a.acknowledged), [alerts]);

  const filteredAlerts = useMemo(() => {
    if (filter === "active") return activeAlerts;
    if (filter === "acknowledged") return ackedAlerts;
    return alerts;
  }, [filter, alerts, activeAlerts, ackedAlerts]);

  const criticalCount = activeAlerts.filter((a) => a.severity === "CRITICAL").length;

  return (
    <div className="card flex flex-col h-full overflow-hidden">
      {/* ── Header ──────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-pulse-border space-y-2.5">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="w-4 h-4 text-pulse-danger" />
          <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            Live Alerts
          </h2>
          <div className="ml-auto flex items-center gap-2">
            {criticalCount > 0 && (
              <span className="bg-red-900/40 text-pulse-danger text-[10px] font-bold px-2 py-0.5 rounded-full animate-pulse">
                {criticalCount} CRITICAL
              </span>
            )}
            <span className="bg-pulse-bg text-pulse-muted text-[10px] font-medium px-2 py-0.5 rounded-full">
              {activeAlerts.length} active
            </span>
          </div>
        </div>

        {/* Filter tabs + Ack All */}
        <div className="flex items-center gap-1">
          {(["all", "active", "acknowledged"] as const).map((tab) => {
            const count = tab === "all" ? alerts.length
              : tab === "active" ? activeAlerts.length
              : ackedAlerts.length;
            return (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`
                  text-[10px] font-medium px-2.5 py-1 rounded-md transition-colors capitalize
                  ${filter === tab
                    ? "bg-pulse-accent/15 text-pulse-accent"
                    : "text-pulse-muted hover:text-gray-300 hover:bg-pulse-bg"
                  }
                `}
              >
                {tab} ({count})
              </button>
            );
          })}

          {activeAlerts.length > 0 && (
            <button
              onClick={acknowledgeAll}
              className="ml-auto flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md
                         text-pulse-success hover:bg-emerald-950/30 transition-colors"
              title="Acknowledge all active alerts"
            >
              <CheckCheck className="w-3 h-3" />
              ACK All
            </button>
          )}
        </div>
      </div>

      {/* ── Scroll indicator ────────────────────────── */}
      {!autoScroll && activeAlerts.length > 0 && (
        <button
          onClick={() => {
            scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            setAutoScroll(true);
          }}
          className="mx-2 mt-1.5 py-1 text-[10px] text-pulse-accent bg-pulse-accent/10
                     rounded-md text-center hover:bg-pulse-accent/20 transition-colors"
        >
          New alerts — scroll to top
        </button>
      )}

      {/* ── Alert List (scrollable) ─────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-2 py-2 space-y-1 min-h-0"
      >
        {filteredAlerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-pulse-muted py-12">
            <div className="w-12 h-12 rounded-full bg-pulse-bg flex items-center justify-center mb-3">
              {filter === "acknowledged"
                ? <CheckCircle2 className="w-6 h-6 opacity-30" />
                : <ShieldAlert className="w-6 h-6 opacity-30" />
              }
            </div>
            <p className="text-sm font-medium">
              {filter === "active" ? "No active alerts" : filter === "acknowledged" ? "No acknowledged alerts" : "No alerts"}
            </p>
            <p className="text-xs mt-0.5">
              {filter === "active" ? "All clear — system within thresholds" : "Alerts will appear here"}
            </p>
          </div>
        ) : (
          filteredAlerts.map((alert, i) => (
            <AlertItem
              key={alert.id ?? `${alert.sensorId}-${alert.triggeredAt}-${i}`}
              alert={alert}
              onAcknowledge={acknowledgeAlert}
            />
          ))
        )}
      </div>

      {/* ── Footer stats ────────────────────────────── */}
      <div className="px-4 py-2 border-t border-pulse-border flex items-center justify-between text-[9px] text-pulse-muted">
        <span>{alerts.length} total · {activeAlerts.length} active · {ackedAlerts.length} ack'd</span>
        <span className="flex items-center gap-1">
          <Filter className="w-2.5 h-2.5" />
          {filter}
        </span>
      </div>
    </div>
  );
}

// ─── Alert Item Component ────────────────────────────────
function AlertItem({
  alert,
  onAcknowledge,
}: {
  alert: Alert;
  onAcknowledge: (id: string) => void;
}) {
  const isCritical = alert.severity === "CRITICAL";
  const isAcked = alert.acknowledged;

  return (
    <div
      className={`
        animate-slide-in rounded-lg border-l-[3px] transition-all duration-300 group
        ${isAcked
          ? "bg-pulse-bg/50 border-l-pulse-muted/30 opacity-50 hover:opacity-80"
          : isCritical
            ? "bg-red-950/20 border-l-pulse-danger hover:bg-red-950/30"
            : "bg-yellow-950/10 border-l-pulse-warning hover:bg-yellow-950/20"
        }
      `}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          {/* Icon */}
          {isAcked ? (
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-pulse-success/50 flex-shrink-0" />
          ) : isCritical ? (
            <AlertOctagon className="w-3.5 h-3.5 mt-0.5 text-pulse-danger flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-pulse-warning flex-shrink-0" />
          )}

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`text-[11px] font-semibold truncate ${isAcked ? "text-pulse-muted" : "text-gray-300"}`}>
                {alert.sensorId}
              </span>
              <span className={`text-[9px] font-bold px-1 py-px rounded ${
                isAcked
                  ? "bg-emerald-900/20 text-emerald-600"
                  : isCritical
                    ? "bg-red-900/40 text-red-400"
                    : "bg-yellow-900/30 text-yellow-400"
              }`}>
                {isAcked ? "ACK" : alert.severity}
              </span>
              <span className="text-[9px] text-pulse-muted ml-auto flex-shrink-0">
                {timeAgo(alert.triggeredAt)}
              </span>
            </div>
            <p className={`text-[11px] mt-0.5 leading-snug ${isAcked ? "text-pulse-muted/70" : "text-pulse-muted-light"}`}>
              {alert.message}
            </p>
            <div className="flex items-center justify-between mt-1.5">
              <div className="flex items-center gap-2 text-[9px] text-pulse-muted">
                <span>{formatTime(alert.triggeredAt)}</span>
                {isAcked && alert.acknowledgedAt && (
                  <>
                    <span>·</span>
                    <span className="text-emerald-600">
                      ack'd {formatTime(alert.acknowledgedAt)}
                    </span>
                  </>
                )}
              </div>

              {/* ACK button */}
              {!isAcked && (
                <button
                  onClick={() => onAcknowledge(alert.id)}
                  className="flex items-center gap-1 text-[9px] font-medium px-2 py-0.5 rounded
                             text-pulse-muted hover:text-pulse-success hover:bg-emerald-950/30
                             opacity-0 group-hover:opacity-100 transition-all"
                >
                  <CheckCircle2 className="w-3 h-3" />
                  Acknowledge
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

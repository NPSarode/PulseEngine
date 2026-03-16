import { create } from "zustand";

// ─── Domain Types ────────────────────────────────────────
export interface TelemetryPoint {
  sensorId: string;
  metricType: string;
  value: number;
  unit?: string;
  timestamp: string;
}

export interface Alert {
  id: string;
  sensorId: string;
  metricType: string;
  thresholdValue: number;
  actualValue: number;
  severity: "WARNING" | "CRITICAL";
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
}

export interface SensorStatus {
  sensorId: string;
  metricType: string;
  latestValue: number;
  unit?: string;
  isAlert: boolean;
  lastUpdate: string;
}

// ─── Store ───────────────────────────────────────────────
interface TelemetryState {
  streams: Record<string, TelemetryPoint[]>;
  sensors: Record<string, SensorStatus>;
  alerts: Alert[];
  connected: boolean;
  eventsPerSecond: number;

  pushTelemetry: (points: TelemetryPoint[]) => void;
  pushAlert: (alert: Alert) => void;
  acknowledgeAlert: (alertId: string) => void;
  acknowledgeAll: () => void;
  setConnected: (connected: boolean) => void;
  setEventsPerSecond: (eps: number) => void;
}

const WINDOW_MS = 60_000;
const MAX_ALERTS = 100;

export const useTelemetryStore = create<TelemetryState>((set) => ({
  streams: {},
  sensors: {},
  alerts: [],
  connected: false,
  eventsPerSecond: 0,

  pushTelemetry: (points) =>
    set((state) => {
      const now = Date.now();
      const cutoff = new Date(now - WINDOW_MS).toISOString();
      const streams = { ...state.streams };
      const sensors = { ...state.sensors };

      for (const point of points) {
        const key = point.sensorId;
        const existing = streams[key] ?? [];
        const filtered = existing.filter((p) => p.timestamp > cutoff);
        filtered.push(point);
        streams[key] = filtered;

        sensors[key] = {
          sensorId: point.sensorId,
          metricType: point.metricType,
          latestValue: point.value,
          unit: point.unit,
          isAlert: sensors[key]?.isAlert ?? false,
          lastUpdate: point.timestamp,
        };
      }

      return { streams, sensors };
    }),

  pushAlert: (alert) =>
    set((state) => {
      const sensors = { ...state.sensors };
      if (sensors[alert.sensorId]) {
        sensors[alert.sensorId] = {
          ...sensors[alert.sensorId],
          isAlert: true,
        };
      }

      const newAlert: Alert = { ...alert, acknowledged: false };
      return {
        alerts: [newAlert, ...state.alerts].slice(0, MAX_ALERTS),
        sensors,
      };
    }),

  acknowledgeAlert: (alertId) =>
    set((state) => {
      const alerts = state.alerts.map((a) =>
        a.id === alertId
          ? { ...a, acknowledged: true, acknowledgedAt: new Date().toISOString() }
          : a
      );

      // Clear sensor alert flag if no more unacknowledged alerts for that sensor
      const sensors = { ...state.sensors };
      const ackedAlert = state.alerts.find((a) => a.id === alertId);
      if (ackedAlert) {
        const hasActiveAlerts = alerts.some(
          (a) => a.sensorId === ackedAlert.sensorId && !a.acknowledged
        );
        if (!hasActiveAlerts && sensors[ackedAlert.sensorId]) {
          sensors[ackedAlert.sensorId] = {
            ...sensors[ackedAlert.sensorId],
            isAlert: false,
          };
        }
      }

      return { alerts, sensors };
    }),

  acknowledgeAll: () =>
    set((state) => {
      const now = new Date().toISOString();
      const alerts = state.alerts.map((a) =>
        a.acknowledged ? a : { ...a, acknowledged: true, acknowledgedAt: now }
      );

      const sensors = { ...state.sensors };
      for (const key of Object.keys(sensors)) {
        sensors[key] = { ...sensors[key], isAlert: false };
      }

      return { alerts, sensors };
    }),

  setConnected: (connected) => set({ connected }),
  setEventsPerSecond: (eventsPerSecond) => set({ eventsPerSecond }),
}));

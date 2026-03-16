import { useEffect, useRef } from "react";
import {
  HubConnectionBuilder,
  HubConnection,
  LogLevel,
  HttpTransportType,
} from "@microsoft/signalr";
import { useTelemetryStore, TelemetryPoint, Alert } from "../store/telemetryStore";

const HUB_URL = import.meta.env.VITE_HUB_URL ?? "/hub/telemetry";

/**
 * useSignalR — connects to the .NET SignalR Hub, listens for
 * ReceiveTelemetry and ReceiveAlert events, and batches
 * updates into the Zustand store every 100ms.
 */
export function useSignalR() {
  const connectionRef = useRef<HubConnection | null>(null);
  const bufferRef = useRef<TelemetryPoint[]>([]);
  const { pushTelemetry, pushAlert, setConnected, setEventsPerSecond } =
    useTelemetryStore();

  useEffect(() => {
    const connection = new HubConnectionBuilder()
      .withUrl(HUB_URL, {
        transport: HttpTransportType.WebSockets,
        skipNegotiation: true,
      })
      .withAutomaticReconnect([0, 1000, 2000, 5000, 10000])
      .configureLogging(LogLevel.Warning)
      .build();

    connectionRef.current = connection;

    // ── Telemetry batching (flush every 100ms) ───────────
    let eventCounter = 0;
    let emaEps = 0;
    const ALPHA = 0.3;
    const TICK_MS = 100;

    const flushInterval = setInterval(() => {
      const batch = bufferRef.current;
      if (batch.length > 0) {
        bufferRef.current = [];
        pushTelemetry(batch);
      }

      const instantEps = eventCounter * (1000 / TICK_MS);
      emaEps = ALPHA * instantEps + (1 - ALPHA) * emaEps;
      setEventsPerSecond(Math.round(emaEps));
      eventCounter = 0;
    }, TICK_MS);

    // ── Event handlers ───────────────────────────────────
    connection.on("ReceiveTelemetry", (point: TelemetryPoint) => {
      bufferRef.current.push(point);
      eventCounter++;
    });

    connection.on("ReceiveTelemetryBatch", (points: TelemetryPoint[]) => {
      bufferRef.current.push(...points);
      eventCounter += points.length;
    });

    connection.on("ReceiveAlert", (alert: Alert) => {
      pushAlert(alert);
    });

    // ── Connection lifecycle ─────────────────────────────
    connection.onreconnecting(() => setConnected(false));
    connection.onreconnected(() => setConnected(true));
    connection.onclose(() => setConnected(false));

    connection
      .start()
      .then(() => {
        console.log("[SignalR] Connected to", HUB_URL);
        setConnected(true);
      })
      .catch((err) => {
        console.error("[SignalR] Connection failed:", err);
        setConnected(false);
      });

    return () => {
      clearInterval(flushInterval);
      connection.stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return connectionRef;
}

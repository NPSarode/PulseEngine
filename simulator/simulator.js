const WebSocket = require("ws");

// ─── Configuration ───────────────────────────────────────
const WS_URL = process.env.WS_URL || "ws://ingestor:8085";
const SENSORS_COUNT = parseInt(process.env.SENSORS_COUNT || "12", 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || "300", 10);
const BURST_SIZE = parseInt(process.env.BURST_SIZE || "6", 10);

// ─── Thresholds (must match .env) ────────────────────────
const THRESHOLDS = {
  temperature: { low: -10, high: 85 },
  pressure:    { low: null, high: 150 },
  humidity:    { low: null, high: 95 },
};

// ─── Sensor Definitions ─────────────────────────────────
const SENSOR_TEMPLATES = [
  { prefix: "TEMP",  metricType: "temperature", unit: "°C",  baseMin: 25,  baseMax: 70,  driftRate: 0.4,  locations: ["Floor-1", "Floor-2", "Floor-3", "Warehouse-A"] },
  { prefix: "PRESS", metricType: "pressure",    unit: "PSI", baseMin: 40,  baseMax: 110, driftRate: 0.6,  locations: ["Boiler-Room", "Pipeline-A", "Pipeline-B"] },
  { prefix: "HUM",   metricType: "humidity",    unit: "%RH", baseMin: 35,  baseMax: 75,  driftRate: 0.3,  locations: ["Server-Room", "Clean-Room", "Storage-Bay"] },
];

// ─── Sensor Scenarios ────────────────────────────────────
// Each sensor cycles through different behavior phases
const PHASES = {
  NORMAL:       "NORMAL",        // Gentle drift within safe range
  CLIMBING:     "CLIMBING",      // Steadily rising toward threshold
  SPIKE:        "SPIKE",         // Burst past threshold (triggers alert)
  CRITICAL:     "CRITICAL",      // Sustained above threshold
  RECOVERING:   "RECOVERING",    // Dropping back to normal
  LOW_SPIKE:    "LOW_SPIKE",     // Drop below low threshold (temp only)
};

class SensorSimulator {
  constructor(id, template, location) {
    this.id = id;
    this.metricType = template.metricType;
    this.unit = template.unit;
    this.baseMin = template.baseMin;
    this.baseMax = template.baseMax;
    this.driftRate = template.driftRate;
    this.location = location;
    this.threshold = THRESHOLDS[template.metricType] || {};

    // State
    this.value = template.baseMin + Math.random() * (template.baseMax - template.baseMin);
    this.phase = PHASES.NORMAL;
    this.phaseTicksLeft = this.randomPhaseDuration();
    this.alertCount = 0;
  }

  randomPhaseDuration() {
    return 200 + Math.floor(Math.random() * 400); // 200-600 ticks (~10-30s at 50ms interval)
  }

  tick() {
    this.phaseTicksLeft--;

    // ── Phase transitions ───────────────────────────
    if (this.phaseTicksLeft <= 0) {
      this.transitionPhase();
    }

    // ── Value update based on phase ─────────────────
    const noise = (Math.random() - 0.5) * this.driftRate * 0.5;

    switch (this.phase) {
      case PHASES.NORMAL: {
        const mid = (this.baseMin + this.baseMax) / 2;
        this.value += (mid - this.value) * 0.03 + noise;
        break;
      }
      case PHASES.CLIMBING: {
        // Steadily push toward threshold
        const target = this.threshold.high
          ? this.threshold.high * 0.95
          : this.baseMax * 1.2;
        this.value += (target - this.value) * 0.06 + noise * 0.3;
        break;
      }
      case PHASES.SPIKE: {
        // Jump above threshold — this WILL trigger alerts
        const overshoot = this.threshold.high
          ? this.threshold.high * (1.05 + Math.random() * 0.15)
          : this.baseMax * 1.3;
        this.value += (overshoot - this.value) * 0.15 + noise * 0.2;
        break;
      }
      case PHASES.CRITICAL: {
        // Stay above threshold with fluctuation
        const holdLevel = this.threshold.high
          ? this.threshold.high * (1.02 + Math.random() * 0.1)
          : this.baseMax * 1.2;
        this.value += (holdLevel - this.value) * 0.08 + noise;
        break;
      }
      case PHASES.RECOVERING: {
        // Drop back toward safe range
        const safeTarget = (this.baseMin + this.baseMax) / 2;
        this.value += (safeTarget - this.value) * 0.08 + noise * 0.3;
        break;
      }
      case PHASES.LOW_SPIKE: {
        // Drop below low threshold (for temperature)
        const lowTarget = this.threshold.low !== null
          ? this.threshold.low - 5 - Math.random() * 10
          : this.baseMin * 0.3;
        this.value += (lowTarget - this.value) * 0.12 + noise * 0.2;
        break;
      }
    }

    // Track if we're in alert territory
    const isAbove = this.threshold.high && this.value > this.threshold.high;
    const isBelow = this.threshold.low !== null && this.value < this.threshold.low;
    if (isAbove || isBelow) this.alertCount++;

    return {
      sensorId: this.id,
      metricType: this.metricType,
      value: parseFloat(this.value.toFixed(2)),
      unit: this.unit,
      timestamp: new Date().toISOString(),
      metadata: {
        location: this.location,
        phase: this.phase,
        simulated: true,
      },
    };
  }

  transitionPhase() {
    const roll = Math.random();
    const prev = this.phase;

    switch (this.phase) {
      case PHASES.NORMAL:
        // 8% chance to start climbing, 2% chance to low spike (temp only)
        if (roll < 0.08) {
          this.phase = PHASES.CLIMBING;
        } else if (roll < 0.10 && this.threshold.low !== null) {
          this.phase = PHASES.LOW_SPIKE;
        }
        break;

      case PHASES.CLIMBING:
        // 40% chance to spike, 60% back to normal
        this.phase = roll < 0.40 ? PHASES.SPIKE : PHASES.NORMAL;
        break;

      case PHASES.SPIKE:
        // 25% stay critical, 75% start recovering
        this.phase = roll < 0.25 ? PHASES.CRITICAL : PHASES.RECOVERING;
        break;

      case PHASES.CRITICAL:
        // Eventually recover
        this.phase = PHASES.RECOVERING;
        break;

      case PHASES.RECOVERING:
        this.phase = PHASES.NORMAL;
        break;

      case PHASES.LOW_SPIKE:
        this.phase = PHASES.RECOVERING;
        break;
    }

    this.phaseTicksLeft = this.randomPhaseDuration();

    // Shorter phases for dramatic events (but still scaled for 50ms ticks)
    if (this.phase === PHASES.SPIKE) this.phaseTicksLeft = 40 + Math.floor(Math.random() * 60);       // 2-5s
    if (this.phase === PHASES.CRITICAL) this.phaseTicksLeft = 60 + Math.floor(Math.random() * 100);   // 3-8s
    if (this.phase === PHASES.LOW_SPIKE) this.phaseTicksLeft = 40 + Math.floor(Math.random() * 60);   // 2-5s

    if (prev !== this.phase) {
      const emoji = {
        [PHASES.NORMAL]: "✅",
        [PHASES.CLIMBING]: "📈",
        [PHASES.SPIKE]: "🔺",
        [PHASES.CRITICAL]: "🚨",
        [PHASES.RECOVERING]: "📉",
        [PHASES.LOW_SPIKE]: "🔻",
      };
      console.log(
        `[Phase] ${this.id}: ${prev} → ${this.phase} ${emoji[this.phase] || ""} ` +
        `(value: ${this.value.toFixed(1)}, duration: ${this.phaseTicksLeft} ticks)`
      );
    }
  }
}

// ─── Create Sensor Fleet ─────────────────────────────────
function createSensors(count) {
  const sensors = [];
  let sensorNum = 1;

  while (sensors.length < count) {
    for (const template of SENSOR_TEMPLATES) {
      if (sensors.length >= count) break;
      const location = template.locations[sensors.length % template.locations.length];
      const id = `${template.prefix}-${location.toUpperCase()}-${String(sensorNum).padStart(3, "0")}`;
      sensors.push(new SensorSimulator(id, template, location));
      sensorNum++;
    }
  }

  // Stagger start: only 1 sensor starts climbing, rest stay normal
  sensors.forEach((s, i) => {
    if (i === 3) {
      s.phase = PHASES.CLIMBING;
      s.phaseTicksLeft = 100 + Math.floor(Math.random() * 200);
    }
  });

  return sensors;
}

// ─── WebSocket Client with Auto-Reconnect ────────────────
function connect() {
  console.log(`[Simulator] Connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);
  let sendInterval = null;
  let statsInterval = null;
  let messagesSent = 0;
  let acksReceived = 0;

  const sensors = createSensors(SENSORS_COUNT);

  console.log(`[Simulator] Created ${sensors.length} sensors:`);
  sensors.forEach((s) => {
    console.log(`  • ${s.id} (${s.metricType}, ${s.unit}) @ ${s.location} [phase: ${s.phase}]`);
  });

  ws.on("open", () => {
    const evtRate = (BURST_SIZE * (1000 / INTERVAL_MS)).toFixed(0);
    console.log(`\n[Simulator] Connected! Rate: ~${evtRate} events/sec`);
    console.log(`[Simulator] Alert scenarios will trigger within 10-30 seconds\n`);

    sendInterval = setInterval(() => {
      for (let i = 0; i < BURST_SIZE; i++) {
        const sensor = sensors[(messagesSent + i) % sensors.length];
        const event = sensor.tick();
        try {
          ws.send(JSON.stringify(event));
          messagesSent++;
        } catch (err) {
          break;
        }
      }
    }, INTERVAL_MS);

    statsInterval = setInterval(() => {
      const byPhase = {};
      sensors.forEach((s) => {
        byPhase[s.phase] = (byPhase[s.phase] || 0) + 1;
      });

      const alerting = sensors.filter(
        (s) => s.phase === PHASES.SPIKE || s.phase === PHASES.CRITICAL || s.phase === PHASES.LOW_SPIKE
      );

      const totalAlerts = sensors.reduce((sum, s) => sum + s.alertCount, 0);

      console.log(
        `[Stats] Sent: ${messagesSent} | ACKs: ${acksReceived} | ` +
        `Alerts triggered: ${totalAlerts} | ` +
        `Phases: ${Object.entries(byPhase).map(([k, v]) => `${k}:${v}`).join(" ")}`
      );

      if (alerting.length > 0) {
        console.log(
          `  ⚠️  Alerting sensors: ${alerting.map((s) => `${s.id}=${s.value.toFixed(1)}${s.unit}`).join(", ")}`
        );
      }
    }, 5000);
  });

  ws.on("message", () => {
    acksReceived++;
  });

  ws.on("close", () => {
    console.log("[Simulator] Disconnected. Reconnecting in 3s...");
    if (sendInterval) clearInterval(sendInterval);
    if (statsInterval) clearInterval(statsInterval);
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error("[Simulator] Error:", err.message);
  });
}

// ─── Start ───────────────────────────────────────────────
console.log("═══════════════════════════════════════════");
console.log("  PulseEngine · Sensor Simulator v2.0.0   ");
console.log("═══════════════════════════════════════════");
console.log(`  Target:       ${WS_URL}`);
console.log(`  Sensors:      ${SENSORS_COUNT}`);
console.log(`  Interval:     ${INTERVAL_MS}ms`);
console.log(`  Burst:        ${BURST_SIZE} events/tick`);
console.log(`  Scenarios:    NORMAL → CLIMBING → SPIKE → CRITICAL → RECOVERING`);
console.log(`  Thresholds:   TEMP high:85 low:-10 | PRESS high:150 | HUM high:95`);
console.log("═══════════════════════════════════════════");
console.log("");

connect();

interface GaugeRingProps {
  value: number;
  min?: number;
  max?: number;
  label: string;
  unit?: string;
  thresholdHigh?: number;
  size?: number;
}

export function GaugeRing({
  value,
  min = 0,
  max = 100,
  label,
  unit = "",
  thresholdHigh,
  size = 130,
}: GaugeRingProps) {
  const strokeW = 6;
  const radius = (size - strokeW * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const arcFraction = 0.75; // 270° arc
  const offset = circumference * (1 - pct * arcFraction);

  // Color: green → yellow → red
  let color = "#10b981";
  if (thresholdHigh !== undefined) {
    const alertPct = (value - min) / (thresholdHigh - min);
    if (alertPct > 0.95) color = "#ef4444";
    else if (alertPct > 0.75) color = "#f59e0b";
  }

  return (
    <div className="flex flex-col items-center gap-0">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-[135deg]">
          {/* Track */}
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke="#1e293b" strokeWidth={strokeW}
            strokeDasharray={`${circumference * arcFraction} ${circumference * (1 - arcFraction)}`}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={color} strokeWidth={strokeW}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="transition-all duration-500 ease-out"
            style={{ filter: `drop-shadow(0 0 8px ${color}50)` }}
          />
        </svg>
        {/* Center value */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-lg font-bold font-mono tabular-nums leading-none" style={{ color }}>
            {value.toFixed(1)}
          </p>
          <p className="text-[9px] text-pulse-muted mt-0.5">{unit}</p>
        </div>
      </div>
      {/* Label below */}
      <p className="text-[10px] text-pulse-muted text-center truncate max-w-full -mt-2">
        {label}
      </p>
    </div>
  );
}

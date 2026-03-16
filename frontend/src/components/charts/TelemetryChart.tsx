import { useEffect, useRef, useState, useMemo } from "react";
import * as d3 from "d3";
import { TelemetryPoint } from "../../store/telemetryStore";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface TelemetryChartProps {
  data: TelemetryPoint[];
  sensorId: string;
  metricType: string;
  unit?: string;
  thresholdHigh?: number;
  thresholdLow?: number;
}

const METRIC_COLORS: Record<string, { line: string; fill: string }> = {
  temperature: { line: "#f59e0b", fill: "#f59e0b" },
  pressure:    { line: "#3b82f6", fill: "#3b82f6" },
  humidity:    { line: "#10b981", fill: "#10b981" },
};
const DEFAULT_COLOR = { line: "#8b5cf6", fill: "#8b5cf6" };

export function TelemetryChart({
  data,
  sensorId,
  metricType,
  unit = "",
  thresholdHigh,
  thresholdLow,
}: TelemetryChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipGroupRef = useRef<SVGGElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 220 });

  const { line: lineColor } = METRIC_COLORS[metricType.toLowerCase()] ?? DEFAULT_COLOR;

  // ── Stats ──────────────────────────────────────────
  const stats = useMemo(() => {
    if (data.length === 0) return null;
    const vals = data.map((d) => d.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const latest = vals[vals.length - 1];
    const prev = vals.length > 5 ? vals[vals.length - 6] : vals[0];
    const trend = latest - prev;
    return { min, max, avg, latest, trend };
  }, [data]);

  // ── Auto-resize ────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDimensions((prev) => ({ ...prev, width }));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // ── D3 Render ──────────────────────────────────────
  useEffect(() => {
    if (!svgRef.current || data.length === 0 || dimensions.width === 0) return;

    const { line: lc, fill: fc } = METRIC_COLORS[metricType.toLowerCase()] ?? DEFAULT_COLOR;

    const margin = { top: 8, right: 12, bottom: 24, left: 44 };
    const w = dimensions.width - margin.left - margin.right;
    const h = dimensions.height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("width", dimensions.width).attr("height", dimensions.height);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Scales
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60_000);
    const xScale = d3.scaleTime().domain([windowStart, now]).range([0, w]);

    const values = data.map((d) => d.value);
    const yMin = Math.min(d3.min(values) ?? 0, thresholdLow ?? Infinity);
    const yMax = Math.max(d3.max(values) ?? 100, thresholdHigh ?? -Infinity);
    const yPad = (yMax - yMin) * 0.15 || 5;
    const yScale = d3.scaleLinear().domain([yMin - yPad, yMax + yPad]).range([h, 0]);

    // Grid
    g.append("g")
      .call(d3.axisLeft(yScale).tickSize(-w).tickFormat(() => ""))
      .selectAll("line").attr("stroke", "#1e293b").attr("stroke-dasharray", "2,4");
    g.selectAll(".domain").remove();

    // Threshold zones (filled bands)
    if (thresholdHigh !== undefined) {
      g.append("rect")
        .attr("x", 0).attr("y", yScale(yMax + yPad))
        .attr("width", w).attr("height", yScale(thresholdHigh) - yScale(yMax + yPad))
        .attr("fill", "#ef4444").attr("opacity", 0.04);
      g.append("line")
        .attr("x1", 0).attr("x2", w)
        .attr("y1", yScale(thresholdHigh)).attr("y2", yScale(thresholdHigh))
        .attr("stroke", "#ef4444").attr("stroke-width", 1)
        .attr("stroke-dasharray", "4,3").attr("opacity", 0.4);
      g.append("text")
        .attr("x", 4).attr("y", yScale(thresholdHigh) - 4)
        .attr("fill", "#ef4444").attr("font-size", "8px").attr("font-family", "Inter")
        .attr("opacity", 0.7).text(`HIGH ${thresholdHigh}`);
    }
    if (thresholdLow !== undefined) {
      g.append("rect")
        .attr("x", 0).attr("y", yScale(thresholdLow))
        .attr("width", w).attr("height", h - yScale(thresholdLow))
        .attr("fill", "#3b82f6").attr("opacity", 0.04);
      g.append("line")
        .attr("x1", 0).attr("x2", w)
        .attr("y1", yScale(thresholdLow)).attr("y2", yScale(thresholdLow))
        .attr("stroke", "#3b82f6").attr("stroke-width", 1)
        .attr("stroke-dasharray", "4,3").attr("opacity", 0.4);
      g.append("text")
        .attr("x", 4).attr("y", yScale(thresholdLow) + 11)
        .attr("fill", "#3b82f6").attr("font-size", "8px").attr("font-family", "Inter")
        .attr("opacity", 0.7).text(`LOW ${thresholdLow}`);
    }

    // Gradient
    const gradId = `grad-${sensorId.replace(/[^a-zA-Z0-9]/g, "")}`;
    const defs = svg.append("defs");
    const grad = defs.append("linearGradient").attr("id", gradId)
      .attr("x1", "0%").attr("y1", "0%").attr("x2", "0%").attr("y2", "100%");
    grad.append("stop").attr("offset", "0%").attr("stop-color", fc).attr("stop-opacity", 0.2);
    grad.append("stop").attr("offset", "100%").attr("stop-color", fc).attr("stop-opacity", 0.01);

    // Area + Line
    const curve = d3.curveCatmullRom.alpha(0.5);
    g.append("path").datum(data)
      .attr("fill", `url(#${gradId})`)
      .attr("d", d3.area<TelemetryPoint>()
        .x((d) => xScale(new Date(d.timestamp))).y0(h).y1((d) => yScale(d.value)).curve(curve));
    g.append("path").datum(data)
      .attr("fill", "none").attr("stroke", lc).attr("stroke-width", 1.5)
      .attr("d", d3.line<TelemetryPoint>()
        .x((d) => xScale(new Date(d.timestamp))).y((d) => yScale(d.value)).curve(curve));

    // Latest dot with animated glow
    const latest = data[data.length - 1];
    if (latest) {
      const cx = xScale(new Date(latest.timestamp));
      const cy = yScale(latest.value);
      g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 8)
        .attr("fill", lc).attr("opacity", 0.1);
      g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 5)
        .attr("fill", lc).attr("opacity", 0.15);
      g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 3)
        .attr("fill", lc).attr("stroke", "#0a0e17").attr("stroke-width", 1.5);
    }

    // Axes
    g.append("g").attr("transform", `translate(0,${h})`)
      .call(d3.axisBottom(xScale).ticks(5).tickFormat((d) => {
        const date = d as Date;
        return `${date.getMinutes()}:${String(date.getSeconds()).padStart(2, "0")}`;
      }))
      .selectAll("text").attr("fill", "#475569").attr("font-size", "9px").attr("font-family", "Inter");
    g.append("g").call(d3.axisLeft(yScale).ticks(4))
      .selectAll("text").attr("fill", "#475569").attr("font-size", "9px").attr("font-family", "Inter");
    g.selectAll(".domain").attr("stroke", "#1e293b");
    g.selectAll(".tick line").attr("stroke", "#1e293b");

    // ── Interactive Tooltip Layer ─────────────────────
    const tooltipG = g.append("g").attr("class", "tooltip-layer").style("display", "none");
    tooltipGroupRef.current = tooltipG.node();

    // Vertical crosshair line
    tooltipG.append("line")
      .attr("class", "crosshair-v")
      .attr("y1", 0).attr("y2", h)
      .attr("stroke", "#475569").attr("stroke-width", 0.5)
      .attr("stroke-dasharray", "3,3");

    // Horizontal crosshair line
    tooltipG.append("line")
      .attr("class", "crosshair-h")
      .attr("x1", 0).attr("x2", w)
      .attr("stroke", "#475569").attr("stroke-width", 0.5)
      .attr("stroke-dasharray", "3,3");

    // Snap dot
    tooltipG.append("circle")
      .attr("class", "snap-dot-outer")
      .attr("r", 6).attr("fill", lc).attr("opacity", 0.25);
    tooltipG.append("circle")
      .attr("class", "snap-dot")
      .attr("r", 3.5).attr("fill", lc).attr("stroke", "#0a0e17").attr("stroke-width", 1.5);

    // Tooltip box
    const tipBox = tooltipG.append("g").attr("class", "tip-box");
    tipBox.append("rect")
      .attr("rx", 6).attr("ry", 6)
      .attr("fill", "#111827").attr("stroke", "#2a3a50").attr("stroke-width", 1)
      .attr("filter", "drop-shadow(0 4px 12px rgba(0,0,0,0.5))");
    tipBox.append("text").attr("class", "tip-value")
      .attr("fill", "#f1f5f9").attr("font-size", "12px").attr("font-weight", "600")
      .attr("font-family", "JetBrains Mono, monospace");
    tipBox.append("text").attr("class", "tip-time")
      .attr("fill", "#64748b").attr("font-size", "9px").attr("font-family", "Inter, sans-serif");

    // Bisector for finding nearest point
    const bisect = d3.bisector<TelemetryPoint, Date>((d) => new Date(d.timestamp)).left;

    // Overlay rect for mouse events
    g.append("rect")
      .attr("width", w).attr("height", h)
      .attr("fill", "transparent").attr("cursor", "crosshair")
      .on("mouseenter", () => tooltipG.style("display", null))
      .on("mouseleave", () => tooltipG.style("display", "none"))
      .on("mousemove", function (event: MouseEvent) {
        const [mx] = d3.pointer(event, this);
        const hoveredDate = xScale.invert(mx);
        const idx = bisect(data, hoveredDate, 1);
        const d0 = data[idx - 1];
        const d1 = data[idx];
        if (!d0) return;

        const nearest = d1 && (hoveredDate.getTime() - new Date(d0.timestamp).getTime() >
          new Date(d1.timestamp).getTime() - hoveredDate.getTime()) ? d1 : d0;

        const px = xScale(new Date(nearest.timestamp));
        const py = yScale(nearest.value);

        // Move crosshairs
        tooltipG.select(".crosshair-v").attr("x1", px).attr("x2", px);
        tooltipG.select(".crosshair-h").attr("y1", py).attr("y2", py);
        tooltipG.select(".snap-dot-outer").attr("cx", px).attr("cy", py);
        tooltipG.select(".snap-dot").attr("cx", px).attr("cy", py);

        // Tooltip content
        const valText = `${nearest.value.toFixed(2)} ${unit}`;
        const timeText = new Date(nearest.timestamp).toLocaleTimeString("en-US", {
          hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
        });

        const tipValue = tipBox.select(".tip-value").text(valText);
        const tipTime = tipBox.select(".tip-time").text(timeText);

        // Size the box
        const valWidth = (tipValue.node() as SVGTextElement)?.getComputedTextLength() ?? 60;
        const timeWidth = (tipTime.node() as SVGTextElement)?.getComputedTextLength() ?? 40;
        const boxW = Math.max(valWidth, timeWidth) + 20;
        const boxH = 42;

        // Position: flip if near edge
        let tipX = px + 12;
        let tipY = py - boxH - 8;
        if (tipX + boxW > w) tipX = px - boxW - 12;
        if (tipY < 0) tipY = py + 12;

        tipBox.select("rect").attr("x", tipX).attr("y", tipY).attr("width", boxW).attr("height", boxH);
        tipBox.select(".tip-value").attr("x", tipX + 10).attr("y", tipY + 18);
        tipBox.select(".tip-time").attr("x", tipX + 10).attr("y", tipY + 34);
      });

  }, [data, dimensions, thresholdHigh, thresholdLow, sensorId, metricType, unit]);

  // ── Trend icon ─────────────────────────────────────
  const TrendIcon = !stats ? Minus
    : stats.trend > 1 ? TrendingUp
    : stats.trend < -1 ? TrendingDown
    : Minus;

  const trendColor = !stats ? "#64748b"
    : stats.trend > 1 ? (thresholdHigh && stats.latest > thresholdHigh * 0.9 ? "#ef4444" : "#f59e0b")
    : stats.trend < -1 ? "#10b981"
    : "#64748b";

  return (
    <div className="card p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: lineColor }} />
          <h3 className="text-xs font-semibold text-gray-300 truncate">{sensorId}</h3>
          <span className="text-[10px] text-pulse-muted px-1.5 py-0.5 bg-pulse-bg rounded flex-shrink-0">
            {metricType}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Min / Avg / Max */}
          {stats && (
            <div className="hidden sm:flex items-center gap-2 text-[10px]">
              <span className="text-blue-400 font-mono tabular-nums">
                L {stats.min.toFixed(1)}
              </span>
              <span className="text-pulse-muted">·</span>
              <span className="text-pulse-muted-light font-mono tabular-nums">
                ~ {stats.avg.toFixed(1)}
              </span>
              <span className="text-pulse-muted">·</span>
              <span className="text-orange-400 font-mono tabular-nums">
                H {stats.max.toFixed(1)}
              </span>
            </div>
          )}
          {/* Trend + Value */}
          {stats && (
            <div className="flex items-center gap-1.5">
              <TrendIcon className="w-3.5 h-3.5" style={{ color: trendColor }} />
              <span className="text-base font-bold font-mono tabular-nums" style={{ color: lineColor }}>
                {stats.latest.toFixed(1)}
              </span>
              <span className="text-[10px] text-pulse-muted font-sans">{unit}</span>
            </div>
          )}
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} className="w-full">
        <svg ref={svgRef} className="w-full" style={{ cursor: "crosshair" }} />
      </div>

      {/* Footer: data points count + time range */}
      <div className="flex items-center justify-between mt-1.5 text-[9px] text-pulse-muted">
        <span>{data.length} points · 60s window</span>
        <span>hover to inspect</span>
      </div>
    </div>
  );
}

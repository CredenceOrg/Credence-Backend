import { Counter, Gauge, Registry } from "prom-client";

export interface HorizonMetrics {
  reconnectTotal: Counter<string>;
  streamUp: Gauge<string>;
}

let _metrics: HorizonMetrics | null = null;

export function getHorizonMetrics(registry?: Registry): HorizonMetrics {
  if (_metrics) return _metrics;
  const reconnectTotal = new Counter({
    name: "horizon_reconnect_total",
    help: "Total Horizon stream reconnect attempts",
    labelNames: ["stream"] as const,
    registers: registry ? [registry] : [],
  });
  const streamUp = new Gauge({
    name: "horizon_stream_up",
    help: "1 if Horizon stream is connected, 0 otherwise",
    labelNames: ["stream"] as const,
    registers: registry ? [registry] : [],
  });
  _metrics = { reconnectTotal, streamUp };
  return _metrics;
}

export function _resetMetrics(): void { _metrics = null; }

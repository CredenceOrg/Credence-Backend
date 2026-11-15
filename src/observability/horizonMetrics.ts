import { Counter, Gauge, Registry, register } from "prom-client";

export interface HorizonMetrics {
  reconnectTotal: Counter<string>;
  streamUp: Gauge<string>;
}

export interface HorizonListenerGauges {
  cursorLagGauge: Gauge<string>;
  lastCheckpointGauge: Gauge<string>;
}

let _metrics: HorizonMetrics | null = null;

export function getHorizonMetrics(registry?: Registry): HorizonMetrics {
  if (_metrics) return _metrics;
  const reconnectTotal =
    (registry?.getSingleMetric("horizon_reconnect_total") as Counter<string> | undefined) ??
    new Counter({
      name: "horizon_reconnect_total",
      help: "Total Horizon stream reconnect attempts",
      labelNames: ["stream"] as const,
      registers: registry ? [registry] : [],
    });
  const streamUp =
    (registry?.getSingleMetric("horizon_stream_up") as Gauge<string> | undefined) ??
    new Gauge({
      name: "horizon_stream_up",
      help: "1 if Horizon stream is connected, 0 otherwise",
      labelNames: ["stream"] as const,
      registers: registry ? [registry] : [],
    });
  _metrics = { reconnectTotal, streamUp };
  return _metrics;
}

export function getHorizonListenerGauges(
  registry: Registry = register,
): HorizonListenerGauges {
  const cursorLagGauge =
    (registry.getSingleMetric("horizon_listener_cursor_lag_seconds") as
      | Gauge<string>
      | undefined) ??
    new Gauge({
      name: "horizon_listener_cursor_lag_seconds",
      help: "Time elapsed since last Horizon cursor checkpoint",
      labelNames: ["stream_name"],
      registers: [registry],
    });

  const lastCheckpointGauge =
    (registry.getSingleMetric("horizon_listener_last_checkpoint_timestamp") as
      | Gauge<string>
      | undefined) ??
    new Gauge({
      name: "horizon_listener_last_checkpoint_timestamp",
      help: "Unix timestamp of last Horizon cursor checkpoint",
      labelNames: ["stream_name"],
      registers: [registry],
    });

  return { cursorLagGauge, lastCheckpointGauge };
}

export function _resetMetrics(): void { _metrics = null; }

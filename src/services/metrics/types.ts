/**
 * Types for Prometheus metrics service
 */

/**
 * Business event types for custom metrics
 */
export enum MetricEvent {
  BOND_CREATED = 'bond_created',
  BOND_SLASHED = 'bond_slashed',
  SCORE_CALCULATED = 'score_calculated',
  IDENTITY_VERIFIED = 'identity_verified',
  BULK_VERIFICATION = 'bulk_verification',
}

/**
 * HTTP request metadata for metrics
 */
export interface HttpRequestMetadata {
  method: string
  route: string
  statusCode: number
  durationMs: number
}

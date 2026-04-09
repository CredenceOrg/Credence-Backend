/**
 * Timeout observability and metrics collection.
 * 
 * Provides structured logging and metrics collection for timeout events
 * across all service dependencies with reason codes for debugging and SLO monitoring.
 */

import { TimeoutReasonCode, ServiceType } from '../lib/timeouts.js'

/**
 * Timeout event metadata for observability.
 */
export interface TimeoutEvent {
  timestamp: Date
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  operation: string
  timeoutMs: number
  actualDurationMs: number
  error?: Error
  context?: Record<string, unknown>
}

/**
 * Slow operation warning metadata.
 */
export interface SlowOperationEvent {
  timestamp: Date
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  operation: string
  timeoutMs: number
  actualDurationMs: number
  percentageOfTimeout: number
  context?: Record<string, unknown>
}

/**
 * Success operation metrics.
 */
export interface SuccessEvent {
  timestamp: Date
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  operation: string
  timeoutMs: number
  actualDurationMs: number
  context?: Record<string, unknown>
}

/**
 * Aggregated timeout metrics for reporting.
 */
export interface TimeoutMetricsSummary {
  period: {
    start: Date
    end: Date
  }
  totalOperations: number
  timeouts: {
    count: number
    byServiceType: Record<ServiceType, number>
    byReasonCode: Record<TimeoutReasonCode, number>
  }
  slowOperations: {
    count: number
    byServiceType: Record<ServiceType, number>
    byReasonCode: Record<TimeoutReasonCode, number>
  }
  successOperations: {
    count: number
    averageDurationMs: number
    byServiceType: Record<ServiceType, { count: number; avgDurationMs: number }>
  }
}

/**
 * Interface for timeout metrics collectors.
 */
export interface TimeoutMetricsCollector {
  onTimeout(event: TimeoutEvent): void
  onSlowOperation(event: SlowOperationEvent): void
  onSuccess(event: SuccessEvent): void
  getSummary?(period?: { start: Date; end: Date }): TimeoutMetricsSummary | undefined
}

/**
 * Console-based metrics collector for development.
 */
export class ConsoleTimeoutMetrics implements TimeoutMetricsCollector {
  private events: {
    timeouts: TimeoutEvent[]
    slowOps: SlowOperationEvent[]
    successes: SuccessEvent[]
  } = {
    timeouts: [],
    slowOps: [],
    successes: [],
  }

  onTimeout(event: TimeoutEvent): void {
    this.events.timeouts.push(event)
    
    console.error(`🔴 TIMEOUT [${event.serviceType}] ${event.operation}`)
    console.error(`   Reason: ${event.reasonCode}`)
    console.error(`   Duration: ${event.actualDurationMs}ms / ${event.timeoutMs}ms`)
    console.error(`   Timestamp: ${event.timestamp.toISOString()}`)
    if (event.context) {
      console.error(`   Context:`, event.context)
    }
    console.error('')
  }

  onSlowOperation(event: SlowOperationEvent): void {
    this.events.slowOps.push(event)
    
    console.warn(`🟡 SLOW [${event.serviceType}] ${event.operation}`)
    console.warn(`   Reason: ${event.reasonCode}`)
    console.warn(`   Duration: ${event.actualDurationMs}ms / ${event.timeoutMs}ms (${event.percentageOfTimeout.toFixed(1)}%)`)
    console.warn(`   Timestamp: ${event.timestamp.toISOString()}`)
    if (event.context) {
      console.warn(`   Context:`, event.context)
    }
    console.warn('')
  }

  onSuccess(event: SuccessEvent): void {
    this.events.successes.push(event)
    
    // Only log successful operations that are close to timeout
    if (event.actualDurationMs > event.timeoutMs * 0.7) {
      console.info(`🟠 NEAR_TIMEOUT [${event.serviceType}] ${event.operation}`)
      console.info(`   Reason: ${event.reasonCode}`)
      console.info(`   Duration: ${event.actualDurationMs}ms / ${event.timeoutMs}ms`)
      console.info(`   Timestamp: ${event.timestamp.toISOString()}`)
      console.info('')
    }
  }

  getSummary(period?: { start: Date; end: Date }): TimeoutMetricsSummary {
    const filterEvents = <T extends { timestamp: Date }>(events: T[]): T[] => {
      if (!period) return events
      return events.filter(e => e.timestamp >= period.start && e.timestamp <= period.end)
    }

    const timeouts = filterEvents(this.events.timeouts)
    const slowOps = filterEvents(this.events.slowOps)
    const successes = filterEvents(this.events.successes)

    const groupByServiceType = <T extends { serviceType: ServiceType }>(events: T[]): Record<ServiceType, number> => {
      const groups: Partial<Record<ServiceType, number>> = {}
      for (const event of events) {
        groups[event.serviceType] = (groups[event.serviceType] || 0) + 1
      }
      return groups as Record<ServiceType, number>
    }

    const groupByReasonCode = <T extends { reasonCode: TimeoutReasonCode }>(events: T[]): Record<TimeoutReasonCode, number> => {
      const groups: Partial<Record<TimeoutReasonCode, number>> = {}
      for (const event of events) {
        groups[event.reasonCode] = (groups[event.reasonCode] || 0) + 1
      }
      return groups as Record<TimeoutReasonCode, number>
    }

    const successByService = successes.reduce((acc, event) => {
      if (!acc[event.serviceType]) {
        acc[event.serviceType] = { count: 0, totalDurationMs: 0 }
      }
      acc[event.serviceType].count++
      acc[event.serviceType].totalDurationMs += event.actualDurationMs
      return acc
    }, {} as Record<ServiceType, { count: number; totalDurationMs: number }>)

    const successByServiceType: Record<ServiceType, { count: number; avgDurationMs: number }> = {} as any
    for (const [serviceType, data] of Object.entries(successByService)) {
      successByServiceType[serviceType as ServiceType] = {
        count: data.count,
        avgDurationMs: data.totalDurationMs / data.count,
      }
    }

    return {
      period: {
        start: period?.start || new Date(0),
        end: period?.end || new Date(),
      },
      totalOperations: timeouts.length + slowOps.length + successes.length,
      timeouts: {
        count: timeouts.length,
        byServiceType: groupByServiceType(timeouts),
        byReasonCode: groupByReasonCode(timeouts),
      },
      slowOperations: {
        count: slowOps.length,
        byServiceType: groupByServiceType(slowOps),
        byReasonCode: groupByReasonCode(slowOps),
      },
      successOperations: {
        count: successes.length,
        averageDurationMs: successes.length > 0 
          ? successes.reduce((sum, e) => sum + e.actualDurationMs, 0) / successes.length 
          : 0,
        byServiceType: successByServiceType,
      },
    }
  }

  /**
   * Clears all collected events. Useful for testing or memory management.
   */
  clear(): void {
    this.events.timeouts = []
    this.events.slowOps = []
    this.events.successes = []
  }
}

/**
 * Production-ready metrics collector that integrates with monitoring systems.
 * This is a placeholder for integration with Prometheus, Datadog, etc.
 */
export class ProductionTimeoutMetrics implements TimeoutMetricsCollector {
  constructor(private prefix: string = 'credence_timeouts') {}

  onTimeout(event: TimeoutEvent): void {
    // In production, this would emit metrics to your monitoring system
    // Example: prometheusCounter.inc({ service_type: event.serviceType, reason_code: event.reasonCode })
    console.debug(`[${this.prefix}] timeout: ${event.serviceType} ${event.operation} (${event.reasonCode})`)
  }

  onSlowOperation(event: SlowOperationEvent): void {
    // In production, this would emit metrics to your monitoring system
    console.debug(`[${this.prefix}] slow: ${event.serviceType} ${event.operation} (${event.reasonCode})`)
  }

  onSuccess(event: SuccessEvent): void {
    // In production, this would emit metrics to your monitoring system
    console.debug(`[${this.prefix}] success: ${event.serviceType} ${event.operation} (${event.reasonCode})`)
  }
}

/**
 * Default metrics collector instance.
 * Uses console metrics in development, production metrics in production.
 */
export function createDefaultMetricsCollector(): TimeoutMetricsCollector {
  const nodeEnv = process.env.NODE_ENV || 'development'
  
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return new ConsoleTimeoutMetrics()
  }
  
  return new ProductionTimeoutMetrics()
}

/**
 * Utility to create enriched timeout events with context.
 */
export function createTimeoutEvent(params: {
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  operation: string
  timeoutMs: number
  actualDurationMs: number
  error?: Error
  context?: Record<string, unknown>
}): TimeoutEvent {
  return {
    timestamp: new Date(),
    ...params,
  }
}

/**
 * Utility to create slow operation events.
 */
export function createSlowOperationEvent(params: {
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  operation: string
  timeoutMs: number
  actualDurationMs: number
  context?: Record<string, unknown>
}): SlowOperationEvent {
  const percentageOfTimeout = (params.actualDurationMs / params.timeoutMs) * 100
  
  return {
    timestamp: new Date(),
    percentageOfTimeout,
    ...params,
  }
}

/**
 * Utility to create success events.
 */
export function createSuccessEvent(params: {
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  operation: string
  timeoutMs: number
  actualDurationMs: number
  context?: Record<string, unknown>
}): SuccessEvent {
  return {
    timestamp: new Date(),
    ...params,
  }
}

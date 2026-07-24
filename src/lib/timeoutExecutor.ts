/**
 * Centralized timeout executor utilities.
 * 
 * Provides a unified way to execute operations with timeout budgets,
 * observability, and proper error handling for all service dependencies.
 */

import { 
  TimeoutConfig, 
  TimeoutReasonCode, 
  ServiceType, 
  resolveTimeout,
  createTimeoutConfig,
  isValidTimeoutReasonCode,
  DEFAULT_TIMEOUT_BUDGETS
} from './timeouts.js'
import type { TimeoutMetricsCollector, TimeoutEvent, SuccessEvent } from '../observability/timeoutMetrics.js'
import { createTimeoutEvent, createSuccessEvent } from '../observability/timeoutMetrics.js'

/**
 * Error thrown when an operation exceeds its timeout budget.
 */
export class TimeoutExceededError extends Error {
  public readonly serviceType: ServiceType
  public readonly reasonCode: TimeoutReasonCode
  public readonly timeoutMs: number
  public readonly operation: string

  constructor(params: {
    serviceType: ServiceType
    reasonCode: TimeoutReasonCode
    timeoutMs: number
    operation: string
    cause?: unknown
  }) {
    const message = `Operation '${params.operation}' on ${params.serviceType} timed out after ${params.timeoutMs}ms (${params.reasonCode})`
    super(message, { cause: params.cause })
    
    this.name = 'TimeoutExceededError'
    this.serviceType = params.serviceType
    this.reasonCode = params.reasonCode
    this.timeoutMs = params.timeoutMs
    this.operation = params.operation
  }
}

/**
 * Metrics interface for observability hooks.
 * Implementations can log timeout events, update counters, etc.
 */
export interface TimeoutMetrics {
  onTimeout?: (params: {
    serviceType: ServiceType
    reasonCode: TimeoutReasonCode
    timeoutMs: number
    operation: string
    durationMs: number
  }) => void
  onSuccess?: (params: {
    serviceType: ServiceType
    reasonCode: TimeoutReasonCode
    timeoutMs: number
    operation: string
    durationMs: number
  }) => void
}

/**
 * Adapter to bridge TimeoutMetricsCollector to TimeoutMetrics interface.
 */
export function createMetricsAdapter(collector: TimeoutMetricsCollector): TimeoutMetrics {
  return {
    onTimeout: (params) => {
      collector.onTimeout?.(createTimeoutEvent({
        serviceType: params.serviceType,
        reasonCode: params.reasonCode,
        operation: params.operation,
        timeoutMs: params.timeoutMs,
        actualDurationMs: params.durationMs,
      }))
    },
    onSuccess: (params) => {
      collector.onSuccess?.(createSuccessEvent({
        serviceType: params.serviceType,
        reasonCode: params.reasonCode,
        operation: params.operation,
        timeoutMs: params.timeoutMs,
        actualDurationMs: params.durationMs,
      }))
    },
  }
}

/**
 * Options for executing an operation with timeout.
 */
export interface TimeoutExecutorOptions {
  /** Metrics collector for observability */
  metrics?: TimeoutMetrics
  /** Custom error handler */
  onError?: (error: Error, context: TimeoutContext) => Error
}

/**
 * Context provided to timeout operations.
 */
export interface TimeoutContext {
  serviceType: ServiceType
  reasonCode: TimeoutReasonCode
  timeoutMs: number
  operation: string
  startTime: number
}

/**
 * Executes an async function with timeout enforcement and observability.
 * 
 * @param fn - Async function to execute
 * @param serviceType - Type of service being called
 * @param reasonCode - Timeout reason code for observability
 * @param options - Additional options
 * @returns Result of the function execution
 */
export async function executeWithTimeout<T>(
  fn: (context: TimeoutContext) => Promise<T>,
  serviceType: ServiceType,
  reasonCode: TimeoutReasonCode,
  options: TimeoutExecutorOptions & { overrideMs?: number } = {}
): Promise<T> {
  const config = createTimeoutConfig(serviceType, reasonCode, options.overrideMs)
  return executeWithTimeoutConfig(fn, config, options)
}

/**
 * Executes an async function with timeout configuration.
 * 
 * @param fn - Async function to execute
 * @param config - Timeout configuration
 * @param options - Additional options
 * @returns Result of the function execution
 */
export async function executeWithTimeoutConfig<T>(
  fn: (context: TimeoutContext) => Promise<T>,
  config: TimeoutConfig,
  options: TimeoutExecutorOptions = {}
): Promise<T> {
  // Extract service type from the budget object
  const serviceType = Object.entries(DEFAULT_TIMEOUT_BUDGETS).find(
    ([, budget]) => budget === config.budget
  )?.[0] as ServiceType
  
  const timeoutMs = resolveTimeout(serviceType, config)
  const startTime = Date.now()
  
  const context: TimeoutContext = {
    serviceType,
    reasonCode: config.reasonCode,
    timeoutMs,
    operation: 'unknown',
    startTime,
  }

  // Create abort controller for timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Execute the function with timeout
    const result = await Promise.race([
      fn(context),
      createAbortPromise(controller.signal, timeoutMs)
    ])

    const durationMs = Date.now() - startTime
    options.metrics?.onSuccess?.({
      serviceType: context.serviceType,
      reasonCode: context.reasonCode,
      timeoutMs,
      operation: context.operation,
      durationMs,
    })

    return result
  } catch (error) {
    const durationMs = Date.now() - startTime
    
    // Handle timeout specifically
    if (isAbortError(error)) {
      const timeoutError = new TimeoutExceededError({
        serviceType: context.serviceType,
        reasonCode: context.reasonCode,
        timeoutMs,
        operation: context.operation,
        cause: error,
      })

      options.metrics?.onTimeout?.({
        serviceType: context.serviceType,
        reasonCode: context.reasonCode,
        timeoutMs,
        operation: context.operation,
        durationMs,
      })

      throw options.onError ? options.onError(timeoutError, context) : timeoutError
    }

    // Handle other errors
    throw options.onError ? options.onError(error as Error, context) : error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Executes a database operation with appropriate timeout.
 */
export async function executeDbOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  options: { overrideMs?: number; metrics?: TimeoutMetrics } = {}
): Promise<T> {
  return executeWithTimeout(
    async (context) => {
      // Update operation name in context
      context.operation = operation
      return fn()
    },
    'database',
    operation.includes('transaction') ? 'DB_TRANSACTION_TIMEOUT' : 'DB_QUERY_TIMEOUT',
    options
  )
}

/**
 * Executes a cache operation with appropriate timeout.
 */
export async function executeCacheOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  options: { overrideMs?: number; metrics?: TimeoutMetrics } = {}
): Promise<T> {
  return executeWithTimeout(
    async (context) => {
      context.operation = operation
      return fn()
    },
    'cache',
    operation.includes('set') ? 'CACHE_SET_TIMEOUT' : 'CACHE_GET_TIMEOUT',
    options
  )
}

/**
 * Executes an HTTP request with appropriate timeout.
 */
export async function executeHttpRequest<T>(
  url: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: { overrideMs?: number; metrics?: TimeoutMetrics } = {}
): Promise<T> {
  return executeWithTimeout(
    async (context) => {
      context.operation = `HTTP ${url}`
      // Create a new abort signal for this specific request
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), context.timeoutMs)
      
      try {
        const result = await fn(controller.signal)
        clearTimeout(timeoutId)
        return result
      } catch (error) {
        clearTimeout(timeoutId)
        throw error
      }
    },
    'http',
    'HTTP_REQUEST_TIMEOUT',
    options
  )
}

/**
 * Executes a Soroban RPC operation with appropriate timeout.
 */
export async function executeSorobanOperation<T>(
  method: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: { overrideMs?: number; metrics?: TimeoutMetrics } = {}
): Promise<T> {
  return executeWithTimeout(
    async (context) => {
      context.operation = `SOROBAN_${method}`
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), context.timeoutMs)
      
      try {
        const result = await fn(controller.signal)
        clearTimeout(timeoutId)
        return result
      } catch (error) {
        clearTimeout(timeoutId)
        throw error
      }
    },
    'soroban',
    'SOROBAN_RPC_TIMEOUT',
    options
  )
}

/**
 * Executes a webhook delivery with appropriate timeout.
 */
export async function executeWebhookDelivery<T>(
  url: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: { overrideMs?: number; metrics?: TimeoutMetrics } = {}
): Promise<T> {
  return executeWithTimeout(
    async (context) => {
      context.operation = `WEBHOOK_${url}`
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), context.timeoutMs)
      
      try {
        const result = await fn(controller.signal)
        clearTimeout(timeoutId)
        return result
      } catch (error) {
        clearTimeout(timeoutId)
        throw error
      }
    },
    'webhook',
    'WEBHOOK_DELIVERY_TIMEOUT',
    options
  )
}

/**
 * Creates a promise that rejects when the signal is aborted.
 */
function createAbortPromise(signal: AbortSignal, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Operation aborted'))
      return
    }

    const handleAbort = () => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`))
    }

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

/**
 * Checks if an error is an abort error (timeout or cancellation).
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  // Unwrap one level of cause-chain (undici / Node.js fetch wrapping)
  if (error instanceof Error && error.cause != null && isAbortError(error.cause)) return true
  return false
}

/**
 * Default metrics collector that logs to console.
 * In production, this would be replaced with proper metrics/observability.
 */
export const consoleMetrics: TimeoutMetrics = {
  onTimeout: ({ serviceType, reasonCode, timeoutMs, operation, durationMs }) => {
    console.warn(`[TIMEOUT] ${serviceType} ${operation} - ${reasonCode} after ${durationMs}ms (limit: ${timeoutMs}ms)`)
  },
  onSuccess: ({ serviceType, reasonCode, timeoutMs, operation, durationMs }) => {
    if (durationMs > timeoutMs * 0.8) {
      console.warn(`[SLOW] ${serviceType} ${operation} - ${reasonCode} took ${durationMs}ms (limit: ${timeoutMs}ms)`)
    }
  },
}

/**
 * Utility to wrap existing functions with timeout enforcement.
 */
export function withTimeout<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  serviceType: ServiceType,
  reasonCode: TimeoutReasonCode,
  options: { overrideMs?: number; metrics?: TimeoutMetrics } = {}
): T {
  return (async (...args: Parameters<T>) => {
    return executeWithTimeout(
      async () => fn(...args),
      serviceType,
      reasonCode,
      options
    )
  }) as T
}

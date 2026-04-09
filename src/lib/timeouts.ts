/**
 * Centralized timeout budget management for service dependencies.
 * 
 * Defines sensible default timeout budgets per service type with support for
 * per-call overrides and observability through reason codes.
 */

export type ServiceType = 'database' | 'cache' | 'queue' | 'http' | 'soroban' | 'webhook'

export type TimeoutReasonCode = 
  | 'DB_QUERY_TIMEOUT'
  | 'DB_TRANSACTION_TIMEOUT'
  | 'CACHE_GET_TIMEOUT'
  | 'CACHE_SET_TIMEOUT'
  | 'QUEUE_PUBLISH_TIMEOUT'
  | 'QUEUE_PROCESS_TIMEOUT'
  | 'HTTP_REQUEST_TIMEOUT'
  | 'SOROBAN_RPC_TIMEOUT'
  | 'WEBHOOK_DELIVERY_TIMEOUT'
  | 'CUSTOM_TIMEOUT'

export interface TimeoutBudget {
  /** Default timeout in milliseconds for this service type */
  defaultMs: number
  /** Minimum allowed timeout in milliseconds */
  minMs: number
  /** Maximum allowed timeout in milliseconds */
  maxMs: number
  /** SLO-aligned timeout target in milliseconds */
  targetMs: number
}

export interface TimeoutConfig {
  budget: TimeoutBudget
  /** Optional override for this specific call */
  overrideMs?: number
  /** Reason code for observability */
  reasonCode: TimeoutReasonCode
}

/**
 * Default timeout budgets aligned with SLO targets.
 * These are conservative defaults that balance reliability with responsiveness.
 */
export const DEFAULT_TIMEOUT_BUDGETS: Record<ServiceType, TimeoutBudget> = {
  // Database operations - SQLite is fast but transactions can take longer
  database: {
    defaultMs: 2000,      // 2s default for queries
    minMs: 100,           // 100ms minimum
    maxMs: 10000,         // 10s maximum for complex transactions
    targetMs: 1000,       // 1s SLO target
  },

  // Cache operations - Redis should be very fast
  cache: {
    defaultMs: 500,       // 500ms default
    minMs: 50,            // 50ms minimum
    maxMs: 2000,          // 2s maximum for network issues
    targetMs: 200,        // 200ms SLO target
  },

  // Queue operations - should be fast but allow for batching
  queue: {
    defaultMs: 1000,      // 1s default
    minMs: 100,           // 100ms minimum
    maxMs: 5000,          // 5s maximum for batch operations
    targetMs: 500,        // 500ms SLO target
  },

  // HTTP requests - external services can be slower
  http: {
    defaultMs: 5000,      // 5s default
    minMs: 1000,          // 1s minimum
    maxMs: 30000,         // 30s maximum for slow services
    targetMs: 3000,       // 3s SLO target
  },

  // Soroban RPC - blockchain operations can be variable
  soroban: {
    defaultMs: 5000,      // 5s default (matches current)
    minMs: 2000,          // 2s minimum
    maxMs: 15000,         // 15s maximum for network congestion
    targetMs: 4000,       // 4s SLO target
  },

  // Webhook delivery - external endpoints can be slow
  webhook: {
    defaultMs: 10000,     // 10s default (generous for external services)
    minMs: 2000,          // 2s minimum
    maxMs: 30000,         // 30s maximum
    targetMs: 8000,       // 8s SLO target
  },
}

/**
 * Hard caps for timeout budgets to prevent excessive values.
 * These ensure system stability even with misconfigured overrides.
 */
export const TIMEOUT_HARD_CAPS = {
  database: { maxMs: 30000 },    // 30s absolute max
  cache: { maxMs: 10000 },       // 10s absolute max
  queue: { maxMs: 15000 },       // 15s absolute max
  http: { maxMs: 60000 },        // 60s absolute max
  soroban: { maxMs: 45000 },     // 45s absolute max
  webhook: { maxMs: 60000 },     // 60s absolute max
} as const

/**
 * Validates and clamps a timeout value within budget constraints.
 */
function clampTimeout(
  timeoutMs: number,
  budget: TimeoutBudget,
  serviceType: ServiceType
): number {
  const hardCap = TIMEOUT_HARD_CAPS[serviceType].maxMs
  
  // Apply budget constraints first
  const budgetClamped = Math.max(
    budget.minMs,
    Math.min(timeoutMs, budget.maxMs)
  )
  
  // Then apply hard caps
  return Math.min(budgetClamped, hardCap)
}

/**
 * Resolves the final timeout value for a service call.
 * 
 * Priority order:
 * 1. Per-call override (if provided and valid)
 * 2. Service default budget
 * 3. Hard caps (always applied)
 * 
 * @param serviceType - Type of service being called
 * @param config - Timeout configuration with optional override
 * @returns Final timeout value in milliseconds
 */
export function resolveTimeout(
  serviceType: ServiceType,
  config: TimeoutConfig
): number {
  const budget = DEFAULT_TIMEOUT_BUDGETS[serviceType]
  
  // Use override if provided, otherwise use budget default
  const requestedTimeout = config.overrideMs ?? budget.defaultMs
  
  // Validate and clamp the timeout
  return clampTimeout(requestedTimeout, budget, serviceType)
}

/**
 * Creates a timeout configuration for a specific service call.
 * 
 * @param serviceType - Type of service being called
 * @param reasonCode - Observability reason code
 * @param overrideMs - Optional per-call timeout override
 * @returns Timeout configuration object
 */
export function createTimeoutConfig(
  serviceType: ServiceType,
  reasonCode: TimeoutReasonCode,
  overrideMs?: number
): TimeoutConfig {
  return {
    budget: DEFAULT_TIMEOUT_BUDGETS[serviceType],
    overrideMs,
    reasonCode,
  }
}

/**
 * Utility to extract timeout value from config, useful for existing APIs.
 */
export function getTimeoutMs(config: TimeoutConfig, serviceType: ServiceType): number {
  return resolveTimeout(serviceType, config)
}

/**
 * Type guard to check if a value is a valid timeout reason code.
 */
export function isValidTimeoutReasonCode(code: string): code is TimeoutReasonCode {
  const validCodes: TimeoutReasonCode[] = [
    'DB_QUERY_TIMEOUT',
    'DB_TRANSACTION_TIMEOUT',
    'CACHE_GET_TIMEOUT',
    'CACHE_SET_TIMEOUT',
    'QUEUE_PUBLISH_TIMEOUT',
    'QUEUE_PROCESS_TIMEOUT',
    'HTTP_REQUEST_TIMEOUT',
    'SOROBAN_RPC_TIMEOUT',
    'WEBHOOK_DELIVERY_TIMEOUT',
    'CUSTOM_TIMEOUT',
  ]
  return validCodes.includes(code as TimeoutReasonCode)
}

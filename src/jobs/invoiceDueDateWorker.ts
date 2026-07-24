import {
  type InvoiceDueDateScheduleItem,
  evaluateDueDateActions,
  normalizeToUtcIso,
  validateTimezone,
} from './invoiceDueDate.js'

export interface TenantScheduleContext {
  tenantId: string
  timezone: string
}

export interface TenantContextProvider {
  listTenants(): Promise<TenantScheduleContext[]>
}

export interface InvoiceDueDateRepository {
  listPendingDueDateInvoices(
    tenantId: string,
    nowUtcIso: string,
  ): Promise<InvoiceDueDateScheduleItem[]>

  markDueDateActionTriggered(invoiceId: string, triggeredAtUtc: string): Promise<void>
}

export interface InvoiceDueDateWorkerOptions {
  /** Number of tenants processed per batch. */
  tenantBatchSize?: number
  /** Enable timezone validation for early error detection. */
  validateTimezones?: boolean
  /** Enable DST transition logging for debugging. */
  logDstTransitions?: boolean
  logger?: (message: string) => void
}

export interface InvoiceDueDateWorkerResult {
  processedTenants: number
  evaluatedInvoices: number
  triggeredActions: number
  errors: number
  duration: number
  startTime: string
}

/**
 * Cron-friendly worker that evaluates invoice due-date actions per tenant timezone.
 */
export class InvoiceDueDateWorker {
  private readonly tenantBatchSize: number
  private readonly validateTimezones: boolean
  private readonly logDstTransitions: boolean
  private readonly logger: (message: string) => void

  constructor(
    private readonly repository: InvoiceDueDateRepository,
    private readonly tenantContextProvider: TenantContextProvider,
    options: InvoiceDueDateWorkerOptions = {},
  ) {
    this.tenantBatchSize = options.tenantBatchSize ?? 200
    this.validateTimezones = options.validateTimezones ?? true
    this.logDstTransitions = options.logDstTransitions ?? false
    this.logger = options.logger ?? (() => {})
  }

  async run(nowUtc: Date | string = new Date()): Promise<InvoiceDueDateWorkerResult> {
    const startMs = Date.now()
    const startTime = normalizeToUtcIso(nowUtc)

    let processedTenants = 0
    let evaluatedInvoices = 0
    let triggeredActions = 0
    let errors = 0

    const tenants = await this.tenantContextProvider.listTenants()
    this.logger(`Evaluating due-date actions for ${tenants.length} tenants`)

    // Pre-validate all timezones if enabled
    if (this.validateTimezones) {
      for (const tenant of tenants) {
        try {
          validateTimezone(tenant.timezone)
        } catch (error) {
          errors += 1
          const message = error instanceof Error ? error.message : 'Unknown timezone validation error'
          this.logger(`Invalid timezone for tenant ${tenant.tenantId}: ${message}`)
        }
      }
    }

    for (let i = 0; i < tenants.length; i += this.tenantBatchSize) {
      const batch = tenants.slice(i, i + this.tenantBatchSize)

      for (const tenant of batch) {
        try {
          // Skip tenant if timezone validation failed
          if (this.validateTimezones) {
            try {
              validateTimezone(tenant.timezone)
            } catch {
              continue // Skip this tenant
            }
          }

          const invoices = await this.repository.listPendingDueDateInvoices(tenant.tenantId, startTime)
          evaluatedInvoices += invoices.length

          const dueNow = evaluateDueDateActions({
            invoices,
            tenantTimezone: tenant.timezone,
            nowUtc,
          })

          // Log DST transition information if enabled
          if (this.logDstTransitions && dueNow.length > 0) {
            const now = new Date(startTime)
            const isTransition = dueNow.some(invoice => {
              const dueAt = new Date(invoice.dueAtUtc)
              return this.isNearDstTransition(now, tenant.timezone) || 
                     this.isNearDstTransition(dueAt, tenant.timezone)
            })
            
            if (isTransition) {
              this.logger(`DST transition period detected for tenant ${tenant.tenantId} (${tenant.timezone})`)
            }
          }

          for (const invoice of dueNow) {
            await this.repository.markDueDateActionTriggered(invoice.invoiceId, startTime)
            triggeredActions += 1
          }

          processedTenants += 1
        } catch (error) {
          errors += 1
          const message = error instanceof Error ? error.message : 'Unknown worker error'
          this.logger(`Failed tenant ${tenant.tenantId}: ${message}`)
        }
      }
    }

    return {
      processedTenants,
      evaluatedInvoices,
      triggeredActions,
      errors,
      duration: Date.now() - startMs,
      startTime,
    }
  }

  /**
   * Simple DST transition detection for logging purposes.
   * This is a lightweight version of the full detection in invoiceDueDate.ts
   */
  private isNearDstTransition(date: Date, timezone: string): boolean {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        timeZoneName: 'short',
      })
      
      const parts = formatter.formatToParts(date)
      const tzName = parts.find(p => p.type === 'timeZoneName')?.value
      
      // Check if timezone name suggests DST (contains 'DT' for Daylight Time)
      return tzName?.includes('DT') ?? false
    } catch {
      return false
    }
  }
}

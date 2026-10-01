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
  /**
   * Skip invoices whose `dueAtUtc` cannot be parsed instead of failing the
   * whole tenant. Enabled by default so a single malformed row cannot starve
   * every other invoice for that tenant indefinitely.
   */
  skipMalformedInvoices?: boolean
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
  private readonly skipMalformedInvoices: boolean
  private readonly logger: (message: string) => void

  constructor(
    private readonly repository: InvoiceDueDateRepository,
    private readonly tenantContextProvider: TenantContextProvider,
    options: InvoiceDueDateWorkerOptions = {},
  ) {
    this.tenantBatchSize = options.tenantBatchSize ?? 200
    this.validateTimezones = options.validateTimezones ?? true
    this.logDstTransitions = options.logDstTransitions ?? false
    this.skipMalformedInvoices = options.skipMalformedInvoices ?? true
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

          // A single unparseable `dueAtUtc` must not abort the tenant: that would
          // starve every other eligible invoice for this tenant on every run.
          const evaluable = this.skipMalformedInvoices
            ? invoices.filter((invoice) => {
                try {
                  normalizeToUtcIso(invoice.dueAtUtc)
                  return true
                } catch (error) {
                  errors += 1
                  const message = error instanceof Error ? error.message : 'Unknown timestamp error'
                  this.logger(
                    `Skipping invoice ${invoice.invoiceId} for tenant ${tenant.tenantId}: ${message}`,
                  )
                  return false
                }
              })
            : invoices

          const dueNow = evaluateDueDateActions({
            invoices: evaluable,
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

          // Trigger each invoice independently: one persistently failing invoice
          // must not block the remaining invoices for this tenant on this run.
          for (const invoice of dueNow) {
            try {
              await this.repository.markDueDateActionTriggered(invoice.invoiceId, startTime)
              triggeredActions += 1
            } catch (error) {
              errors += 1
              const message = error instanceof Error ? error.message : 'Unknown trigger error'
              this.logger(
                `Failed to trigger invoice ${invoice.invoiceId} for tenant ${tenant.tenantId}: ${message}`,
              )
            }
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

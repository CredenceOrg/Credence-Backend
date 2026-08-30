import client from 'prom-client'

export type ImportRowMetricStatus = 'accepted' | 'rejected' | 'retried'

/** Counts row outcomes without recording addresses, emails, or other payload data. */
export const importRowsTotal = new client.Counter({
  name: 'import_rows_total',
  help: 'Import row outcomes by validation/commit status',
  labelNames: ['status'],
})

export function recordImportRows(status: ImportRowMetricStatus, count = 1): void {
  if (count > 0) importRowsTotal.inc({ status }, count)
}

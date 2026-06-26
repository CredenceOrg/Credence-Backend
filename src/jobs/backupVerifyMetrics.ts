import client from 'prom-client'
import { register } from '../middleware/metrics.js'

export const backupRestoreVerifySeconds = new client.Histogram({
  name: 'backup_restore_verify_seconds',
  help: 'Duration of backup restore and verification in seconds',
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
})

export const backupRestoreFailedTotal = new client.Counter({
  name: 'backup_restore_failed_total',
  help: 'Total number of backup restore failures',
  labelNames: ['step'] as const,
  registers: [register],
})

export interface BackupVerifyMetrics {
  observeDuration(seconds: number): void
  incFailure(step: string): void
}

export function createBackupVerifyMetrics(): BackupVerifyMetrics {
  return {
    observeDuration: (seconds) => backupRestoreVerifySeconds.observe(seconds),
    incFailure: (step) => backupRestoreFailedTotal.inc({ step }),
  }
}

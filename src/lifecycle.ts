let ready = true

export function isReady(): boolean {
  return ready
}

export function setReady(value: boolean): void {
  ready = value
}

/**
 * Idempotently bootstrap the {@link KeyManager} singleton at server
 * startup so the `/.well-known/jwks.json` endpoint and JWT signing
 * respond with real data from the first request.
 *
 * Behaviour:
 *  • On first call: marks the app as not ready, awaits
 *    `keyManager.initialize()` (which imports `KEY_PRIVATE_PEM` when set
 *    or generates a fresh RSA-2048 PS256 keypair), then marks ready.
 *  • On subsequent calls: returns immediately (no-op).
 *
 * Logs are written via the global `logger` so failures during boot are
 * visible to the operator.
 */
export async function initializeAuth(): Promise<void> {
  setReady(false)
  try {
    const { keyManager } = await import('./services/keyManager/index.js')
    await keyManager.initialize()
  } catch (err) {
    const { logger } = await import('./utils/logger.js')
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[lifecycle] KeyManager bootstrap failed: ${message}`)
    throw err
  } finally {
    setReady(true)
  }
}

import { createServer } from 'node:http'
import { createApp } from './index.js'
import { createAppResources } from './infra/resources.js'
import { createGracefulShutdownManager, createRequestTracker } from './lifecycle/gracefulShutdown.js'

const PORT = Number(process.env.PORT ?? 3000)

/**
 * Parses required shutdown timeout from SHUTDOWN_TIMEOUT_MS env var.
 */
export function getRequiredShutdownTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const value = env.SHUTDOWN_TIMEOUT_MS
  if (!value) {
    throw new Error('SHUTDOWN_TIMEOUT_MS is required')
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must be a positive integer in milliseconds')
  }
  return parsed
}

/**
 * Starts HTTP server with graceful shutdown lifecycle.
 */
export async function startServer(): Promise<void> {
  const tracker = createRequestTracker()
  const app = createApp({ preRouteMiddlewares: [tracker.middleware] })
  const server = createServer(app)
  const resources = createAppResources()
  const timeoutMs = getRequiredShutdownTimeoutMs()

  const shutdownManager = createGracefulShutdownManager({
    server,
    timeoutMs,
    tracker,
    resources: [
      { name: 'db pool', close: () => resources.closeDbPool() },
      { name: 'redis client', close: () => resources.closeRedis() },
    ],
  })

  process.once('SIGTERM', () => {
    void shutdownManager.shutdown('SIGTERM')
  })
  process.once('SIGINT', () => {
    void shutdownManager.shutdown('SIGINT')
  })

  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      console.log(`Credence API listening on http://localhost:${PORT}`)
      resolve()
    })
  })
}

if (process.env.NODE_ENV !== 'test') {
  void startServer()
}

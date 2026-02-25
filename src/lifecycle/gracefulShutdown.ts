import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Server } from 'node:http'

/**
 * Tracks in-flight requests and blocks new requests during shutdown.
 */
export interface RequestTracker {
  middleware: RequestHandler
  getInFlight(): number
  setDraining(value: boolean): void
}

/**
 * Resource close operation executed during graceful shutdown.
 */
export interface ShutdownResource {
  name: string
  close: () => Promise<void>
}

/**
 * Logger contract for shutdown lifecycle messages.
 */
export interface ShutdownLogger {
  info(message: string): void
  error(message: string): void
}

/**
 * Graceful shutdown manager contract.
 */
export interface GracefulShutdownManager {
  shutdown(signal: NodeJS.Signals): Promise<void>
}

/**
 * Creates in-flight request tracker middleware.
 */
export function createRequestTracker(): RequestTracker {
  let inFlight = 0
  let draining = false

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (draining) {
      res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'Server is shutting down',
      })
      return
    }

    inFlight += 1
    let done = false
    const finalize = () => {
      if (done) {
        return
      }
      done = true
      inFlight = Math.max(0, inFlight - 1)
    }
    res.once('finish', finalize)
    res.once('close', finalize)
    next()
  }

  return {
    middleware,
    getInFlight: () => inFlight,
    setDraining: (value: boolean) => {
      draining = value
    },
  }
}

/**
 * Creates graceful shutdown manager for signal-driven server termination.
 */
export function createGracefulShutdownManager(options: {
  server: Pick<Server, 'close'>
  timeoutMs: number
  tracker: RequestTracker
  resources: ShutdownResource[]
  logger?: ShutdownLogger
  exitFn?: (code: number) => void
}): GracefulShutdownManager {
  const logger: ShutdownLogger = options.logger ?? {
    info: (message: string) => console.info(message),
    error: (message: string) => console.error(message),
  }
  const exitFn = options.exitFn ?? ((code: number) => process.exit(code))

  let shuttingDownPromise: Promise<void> | null = null

  return {
    async shutdown(signal: NodeJS.Signals): Promise<void> {
      if (shuttingDownPromise) {
        return shuttingDownPromise
      }

      shuttingDownPromise = (async () => {
        logger.info(`[shutdown] signal received: ${signal}`)
        options.tracker.setDraining(true)

        const timeoutError = new Error(`graceful shutdown timed out after ${options.timeoutMs}ms`)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(timeoutError), options.timeoutMs)
        })

        try {
          await Promise.race([
            performShutdown(options.server, options.tracker, options.resources, logger),
            timeoutPromise,
          ])
          logger.info('[shutdown] completed successfully')
          exitFn(0)
        } catch (error) {
          logger.error(
            `[shutdown] failed: ${error instanceof Error ? error.message : 'unknown error'}`
          )
          exitFn(1)
        }
      })()

      return shuttingDownPromise
    },
  }
}

async function performShutdown(
  server: Pick<Server, 'close'>,
  tracker: RequestTracker,
  resources: ShutdownResource[],
  logger: ShutdownLogger
): Promise<void> {
  logger.info('[shutdown] stopping server from accepting new connections')
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  logger.info('[shutdown] waiting for in-flight requests to complete')
  while (tracker.getInFlight() > 0) {
    await wait(25)
  }

  for (const resource of resources) {
    logger.info(`[shutdown] closing ${resource.name}`)
    await resource.close()
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

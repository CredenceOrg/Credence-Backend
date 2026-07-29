import type { Express, Request, Response } from 'express'
import { Router } from 'express'

import { echoResponseSchema } from './schemas/echo.js'

/**
 * Handles the unauthenticated connectivity-test endpoint.
 *
 * Express normalizes request header names to lowercase. Header values are
 * returned as received so callers can verify proxy and connectivity behavior.
 */
export function echoHandler(req: Request, res: Response): void {
  const response = {
    headers: req.headers,
  }

  // Keep the runtime response aligned with the public response contract.
  echoResponseSchema.parse(response)
  res.json(response)
}

export const echoRouter = Router()
echoRouter.get('/api/v1/echo', echoHandler)

/**
 * Registers the echo endpoint on an Express application.
 * No authentication middleware is applied by this registration function.
 */
export function registerEchoEndpoint(app: Express): void {
  app.use(echoRouter)
}

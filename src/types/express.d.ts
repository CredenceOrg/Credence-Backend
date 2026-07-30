import { Request } from 'express'
import { RequestLogger } from '../utils/logger.js'

declare global {
  namespace Express {
    interface Request {
      requestId: string
      correlationId: string
      traceId: string
      log: RequestLogger
    }
  }
}


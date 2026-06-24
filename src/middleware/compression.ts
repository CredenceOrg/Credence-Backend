import compression from 'compression'
import { Request, Response, NextFunction } from 'express'
import client from 'prom-client'
import { responseSizeBytes } from './metrics.js'

const threshold = Number(process.env.COMPRESSION_THRESHOLD ?? '1024')

export const compressionMiddleware = compression({
  threshold, // Enable compression only above size threshold
  filter: (req: Request, res: Response) => {
    // Exclude Server-Sent Events from compression to not break framing
    if (req.headers.accept === 'text/event-stream' || res.getHeader('Content-Type') === 'text/event-stream') {
      return false
    }

    // Respect x-no-compression header for explicit exclusions
    if (req.headers['x-no-compression']) {
      return false
    }

    // Fallback to standard filter which checks Cache-Control: no-transform
    // and correctly honors "Accept-Encoding" negotiation
    return compression.filter(req, res)
  }
})

/**
 * Middleware that tracks the final byte size of responses, grouping by whether they
 * were compressed or not. Should be placed *before* the compression middleware
 * in the Express stack to intercept the compressed stream correctly.
 */
export function compressionMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  let size = 0
  
  const originalWrite = res.write
  const originalEnd = res.end

  res.write = function (chunk: any, encodingOrCb?: BufferEncoding | Function, cb?: Function) {
    if (chunk) {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8'
      const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding as BufferEncoding)
      size += chunkLength
    }
    return originalWrite.apply(res, arguments as any)
  }

  res.end = function (chunk?: any, encodingOrCb?: BufferEncoding | Function, cb?: Function) {
    if (chunk && typeof chunk !== 'function') {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8'
      const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding as BufferEncoding)
      size += chunkLength
    }
    
    const contentEncoding = res.getHeader('Content-Encoding')
    const isCompressed = contentEncoding === 'gzip' || contentEncoding === 'br' || contentEncoding === 'deflate'
    
    if (size > 0) {
      responseSizeBytes.observe({ compressed: isCompressed ? 'true' : 'false' }, size)
    }

    return originalEnd.apply(res, arguments as any)
  }
  
  next()
}

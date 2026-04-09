import { AsyncLocalStorage } from 'async_hooks'

// Storage to hold IDs for the duration of a request
export const tracingContext = new AsyncLocalStorage<Map<string, string>>()

type LogLevel = 'INFO' | 'ERROR' | 'WARN' | 'DEBUG'

function formatMessage(level: LogLevel, message: string | object) {
  const context = tracingContext.getStore()
  const requestId = context?.get('requestId') || 'N/A'
  const correlationId = context?.get('correlationId') || 'N/A'

  const metadata = {
    level,
    requestId,
    correlationId,
    timestamp: new Date().toISOString(),
  }

  if (typeof message === 'object') {
    return JSON.stringify({ ...metadata, ...message })
  }

  return `[${metadata.timestamp}] [${level}] [RequestID: ${requestId}] [CorrelationID: ${correlationId}] - ${message}`
}

export const logger = {
  info: (message: string | object) => {
    console.log(formatMessage('INFO', message))
  },
  error: (message: string | object, error?: any) => {
    const msg = error ? { message, error: error.message || error, stack: error.stack } : message
    console.error(formatMessage('ERROR', msg))
  },
  warn: (message: string | object) => {
    console.warn(formatMessage('WARN', message))
  },
  debug: (message: string | object) => {
    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
      console.debug(formatMessage('DEBUG', message))
    }
  },
}

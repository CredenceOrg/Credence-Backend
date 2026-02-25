import { AsyncLocalStorage } from 'async_hooks'

// Storage to hold IDs for the duration of a request
export const tracingContext = new AsyncLocalStorage<Map<string, string>>()

export const logger = {
  info: (message: string) => {
    const context = tracingContext.getStore()
    const requestId = context?.get('requestId') || 'N/A'
    const correlationId = context?.get('correlationId') || 'N/A'

    console.log(
      `[INFO] [RequestID: ${requestId}] [CorrelationID: ${correlationId}] - ${message}`
    )
  },
}

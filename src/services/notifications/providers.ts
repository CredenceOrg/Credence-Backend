import type { EmailNotification, EmailProvider } from './types.js'

/**
 * Base HTTP email provider with configurable endpoint and auth.
 */
export class HttpEmailProvider implements EmailProvider {
  name: string

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly headerName: string = 'Authorization',
    providerName: string = 'http-provider'
  ) {
    this.name = providerName
  }

  async send(
    notification: EmailNotification,
    options?: { timeout?: number }
  ): Promise<{ id: string; statusCode: number }> {
    const timeout = options?.timeout ?? 5000

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [this.headerName]: this.apiKey,
        },
        body: JSON.stringify(this.buildPayload(notification)),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`Email provider returned ${response.status}`)
      }

      const data = await response.json() as Record<string, unknown>
      const messageId = this.extractMessageId(data)

      return {
        id: messageId,
        statusCode: response.status,
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Build provider-specific payload. Override in subclasses.
   */
  protected buildPayload(notification: EmailNotification): unknown {
    return {
      to: notification.recipients.map(r => ({
        email: r.email,
        name: r.name,
      })),
      subject: notification.subject,
      body: notification.body,
      content_type: notification.contentType ?? 'text/html',
    }
  }

  /**
   * Extract message ID from provider response. Override in subclasses.
   */
  protected extractMessageId(response: Record<string, unknown>): string {
    return (response.id ?? response.message_id ?? response.MessageId ?? '') as string
  }
}

/**
 * SendGrid email provider.
 */
export class SendGridProvider extends HttpEmailProvider {
  constructor(apiKey: string) {
    super(
      'https://api.sendgrid.com/v3/mail/send',
      apiKey,
      'Authorization',
      'sendgrid'
    )
  }

  protected buildPayload(notification: EmailNotification): unknown {
    return {
      personalizations: [
        {
          to: notification.recipients.map(r => ({
            email: r.email,
            name: r.name,
          })),
        },
      ],
      from: {
        email: 'noreply@credence.io',
        name: 'Credence',
      },
      subject: notification.subject,
      content: [
        {
          type: notification.contentType ?? 'text/html',
          value: notification.body,
        },
      ],
    }
  }

  protected extractMessageId(response: Record<string, unknown>): string {
    // SendGrid doesn't always return message ID in response; ensure string type.
    const id = response.message_id as unknown
    if (typeof id === 'string' && id.length > 0) {
      return id
    }
    return ''
  }
}

/**
 * Mailgun email provider.
 */
export class MailgunProvider extends HttpEmailProvider {
  constructor(apiKey: string, private readonly domain: string) {
    super(
      `https://api.mailgun.net/v3/${domain}/messages`,
      `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
      'Authorization',
      'mailgun'
    )
  }

  protected buildPayload(notification: EmailNotification): unknown {
    const form = new URLSearchParams()
    form.append('from', 'noreply@credence.io')

    notification.recipients.forEach(r => {
      form.append('to', r.email)
    })

    form.append('subject', notification.subject)
    form.append('html', notification.body)

    return form.toString()
  }

  protected extractMessageId(response: Record<string, unknown>): string {
    return (response.id ?? '') as string
  }
}

/**
 * Mock provider for testing (succeeds immediately).
 */
export class MockEmailProvider implements EmailProvider {
  name = 'mock'
  private messageCount = 0
  private failureMap = new Map<string, { failOnAttempt?: number; errorCode?: number }>()

  async send(
    notification: EmailNotification,
    options?: { timeout?: number }
  ): Promise<{ id: string; statusCode: number }> {
    this.messageCount++

    // Simulate timeout if requested
    if (options?.timeout === 0) {
      await new Promise(() => {})
    }

    const failConfig = this.failureMap.get(notification.id)
    if (failConfig?.failOnAttempt === this.messageCount) {
      throw new Error(`Mock provider error (attempt ${this.messageCount})`)
    }

    return {
      id: `mock-msg-${this.messageCount}`,
      statusCode: failConfig?.errorCode ?? 200,
    }
  }

  /**
   * Configure mock to fail on specific attempt.
   */
  failOnAttempt(notificationId: string, attemptNumber: number, statusCode: number = 500): void {
    this.failureMap.set(notificationId, {
      failOnAttempt: attemptNumber,
      errorCode: statusCode,
    })
  }

  /**
   * Reset mock state.
   */
  reset(): void {
    this.messageCount = 0
    this.failureMap.clear()
  }
}

/**
 * Create a provider instance from name and config.
 */
export function createEmailProvider(
  providerName: string,
  config: Record<string, string>
): EmailProvider {
  switch (providerName.toLowerCase()) {
    case 'sendgrid':
      return new SendGridProvider(config.apiKey || '')
    case 'mailgun':
      return new MailgunProvider(config.apiKey || '', config.domain || '')
    case 'mock':
      return new MockEmailProvider()
    case 'http':
      return new HttpEmailProvider(
        config.endpoint || '',
        config.apiKey || '',
        config.headerName || 'Authorization',
        config.name || 'http-provider'
      )
    default:
      throw new Error(`Unknown email provider: ${providerName}`)
  }
}

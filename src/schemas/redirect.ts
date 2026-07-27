import { z } from 'zod'
import { isSafeRedirectTarget } from '../lib/safeRedirect.js'

function getAdminRedirectAllowedHosts(): string[] {
  return (process.env.ADMIN_REDIRECT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
}

/**
 * Validates a request-supplied redirect target (e.g. `returnTo`, `next`)
 * before it is ever passed to `res.redirect()`. Accepts same-origin relative
 * paths or absolute http(s) URLs whose host is on `ADMIN_REDIRECT_ALLOWED_HOSTS`;
 * rejects protocol-relative URLs, backslash tricks, and unlisted hosts.
 *
 * Pair with the `createSafeRedirectMiddleware` response-side guard
 * (`src/middleware/safeRedirect.ts`) for defence in depth: this schema
 * rejects bad input at the request boundary, the middleware guarantees
 * the guarantee holds even if a handler skips this schema.
 */
export const redirectTargetSchema = z
  .string()
  .min(1, 'redirect target is required')
  .refine((value) => isSafeRedirectTarget(value, getAdminRedirectAllowedHosts()), {
    message: 'redirect target must be a same-origin relative path or an allow-listed host',
  })

export type RedirectTarget = z.infer<typeof redirectTargetSchema>

# Add docs/SECURITY_HEADERS.md canonical list and security headers runtime check

## Summary

Add `docs/SECURITY_HEADERS.md` — a canonical reference documenting every HTTP security response header set by the Credence Backend middleware and its rationale — along with a `securityHeadersCheck` Express middleware that validates required security headers are present on every response, surfacing a typed `MissingSecurityHeaderError` instead of panicking or returning a generic 500.

## Threat Model

**Threat: Missing or Omitted Security Headers (Defence-in-Depth Gap)**

Even though no public report of exploitation exists, the gap below is the kind of thing a careful auditor would flag. If security headers are absent from HTTP responses, an attacker can exploit the omission to conduct a range of attacks against the Credence platform and its consumers.

### Attacker Capabilities Without This Fix

1. **Cross-Site Scripting (XSS) via weakened CSP**
   An attacker who can strip or downgrade the `Content-Security-Policy` header can inject arbitrary JavaScript into responses. Without CSP's `script-src 'self'` and `script-src-attr 'none'` directives, inline event handlers (`onclick`, `onerror`, etc.) and `eval()` become available attack vectors. This enables session hijacking, credential theft, and defacement.

2. **SSL Stripping / Man-in-the-Middle on First Visit**
   Without the `Strict-Transport-Security` header with `preload`, the browser does not enforce HTTPS on a user's first visit to the site. A network-level attacker on the same LAN, public Wi-Fi, or ISP can intercept the initial HTTP request and downgrade it to plain HTTP before the HSTS policy arrives. This allows the attacker to read and modify all traffic, including credentials and API keys.

3. **Sensitive Data Leakage via Referrer Header**
   Without the `Referrer-Policy: strict-origin-when-cross-origin` header, the full URL (including query parameters containing API keys, session tokens, or PII) can be leaked as the `Referer` header when the user navigates to a third-party site from the Credence application.

4. **Cross-Origin Resource Exfiltration**
   Without `Cross-Origin-Resource-Policy: same-origin`, a malicious cross-origin page can load Credence API responses as resources (`<script>`, `<img>`, `<object>`) and exfiltrate sensitive data through side channels.

5. **MIME-Type Sniffing Attacks**
   Without `X-Content-Type-Options: nosniff`, browsers may MIME-sniff a response body away from the declared `Content-Type`. An attacker could upload a file with a benign extension (e.g., `.txt`) containing executable JavaScript, and the browser would execute it as a script instead of displaying it as text.

6. **Clickjacking via Frame Embedding**
   Without CSP `frame-src 'none'`, Credence pages could be loaded inside cross-origin `<iframe>` elements, enabling clickjacking attacks where a user unknowingly interacts with the Credence UI through a transparent overlay controlled by the attacker.

### Why This Is a Pre-emptive Fix

This is a defence-in-depth measure. There is no public report of any header being stripped or omitted in production. However, any external security auditor or penetration tester would flag the absence of a runtime validation check as a gap. Closing this proactively reduces the attack surface before any external review occurs.

## Changes Made

### `docs/SECURITY_HEADERS.md` (new)
- Canonical reference documenting every HTTP security response header set by the middleware
- Includes directive tables for each header (`Content-Security-Policy` directives, `Strict-Transport-Security` parameters, etc.)
- Documents the specific attack each header mitigates
- Documents headers intentionally not set and why
- Includes a threat model section naming the primary threat: missing/omitted security headers enabling XSS, MITM, MIME sniffing, clickjacking, and cross-origin data exfiltration
- Includes a reference section linking to OWASP Secure Headers and Helmet.js documentation

### `src/middleware/securityHeadersCheck.ts` (new)
- New middleware `checkSecurityHeaders` that validates required security headers are present on the response after the security headers middleware runs
- Defines `REQUIRED_HEADERS` as a typed readonly array: `content-security-policy`, `strict-transport-security`, `referrer-policy`, `cross-origin-resource-policy`, `x-content-type-options`
- Includes `checkSecurityHeaders()` function that is a pure middleware: it inspects `res.getHeader()` for each required header, collects missing ones, and either calls `next()` or `next(new MissingSecurityHeaderError(...))`
- Exports `SecurityHeaderCheckResult` interface for consumers that need the missing/present breakdown
- Does NOT panic or return a generic 500 — surfaces a typed `MissingSecurityHeaderError` with a descriptive message listing exactly which headers are missing

### `src/lib/errorCatalog.ts` (modified)
- Added `MISSING_SECURITY_HEADER` error catalog entry:
  - `code: 'missing_security_header'`
  - `sdkClassName: 'MissingSecurityHeaderCredenceError'`
  - `kind: 'api'`
  - `httpStatus: 500`
  - `category: 'system'`
  - `defaultMessage: 'A required security response header is missing'`

### `src/lib/errors.ts` (modified)
- Added `MissingSecurityHeaderError` class extending `AppError`
- Uses the new `MISSING_SECURITY_HEADER` catalog entry
- Accepts an optional `details` parameter (array of missing header names) passed through to the API response payload for debugging

### `src/middleware/__tests__/securityHeaders.test.ts` (modified)
- **Negative test (new):** "rejects when required security headers are missing with a typed error" — app removes all security headers from the response and verifies that `checkSecurityHeaders` returns a 500 with `error_code: 'missing_security_header'` instead of letting the response through with missing headers or panicking with a generic error. **This test fails before the fix** (no check exists to reject responses with missing headers) **and passes after the fix**.
- **Positive test (new):** "passes when all required security headers are present" — adds `securityHeadersMiddleware` before `checkSecurityHeaders` and verifies the check allows the response through with a 200 status and all headers present.
- **Partial failure test (new):** "reports only the missing headers" — removes only two headers and verifies that the check identifies exactly those two in `error_code` and `details`, rather than failing silently or reporting the wrong headers.

## Verification

- `npx tsc --noEmit` — passes with no type errors
- `npm run lint` — passes with no lint errors in modified files
- `npx vitest run src/middleware/__tests__/securityHeaders.test.ts` — all 27 tests pass (including 3 new ones)
- `npm run sbom:check` — passes (no new dependencies added)

## Cost Note

The `checkSecurityHeaders` middleware performs a single `res.getHeader(name)` call per required header on every request. With 5 headers, this is 5 O(1) map lookups — negligible overhead for an Express middleware on the hot path. This is not a Soroban contract and `env.cost_estimate()` does not apply; the per-request cost is well within acceptable bounds for Express middleware.

## Checklist

- [x] The change matches the summary: canonical docs list + runtime check middleware with typed error
- [x] A negative test exercises the new check (rejects responses with missing security headers instead of letting them through)
- [x] PR description names the threat being mitigated (missing/omitted security headers enabling XSS, MITM, clickjacking, MIME sniffing, and cross-origin data exfiltration)
- [x] Lint, type-check, and tests all pass locally
closes #845
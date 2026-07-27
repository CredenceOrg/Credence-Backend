# Security Headers — Canonical Reference

Every HTTP response header set by the Credence Backend security middleware and the rationale behind each. This list is the single source of truth for the security baseline.

## Threat Model

The primary threat mitigated is **response header injection and omission** — an attacker who can influence or strip response headers could:

- Inject malicious scripts via a weakened Content-Security-Policy (cross-site scripting)
- Strip HSTS to enable SSL-stripping man-in-the-middle attacks
- Remove Referrer-Policy to leak sensitive path/query parameters to third-party origins
- Disable X-Content-Type-Options to trigger MIME-type sniffing attacks
- Load Credence resources in cross-origin frames to conduct clickjacking

All of these are defence-in-depth controls. Even though no public exploitation of these gaps has been reported, a careful auditor would flag any deviation from the baseline below.

## Headers

### `Content-Security-Policy`

| Property     | Value                                                               |
|--------------|---------------------------------------------------------------------|
| default-src  | `'self'`                                                            |
| script-src   | `'self'`                                                            |
| script-src-attr | `'none'`                                                        |
| style-src    | `'self'`                                                            |
| img-src      | `'self'`, `data:`, `https:`                                        |
| connect-src  | `'self'`                                                            |
| font-src     | `'self'`                                                            |
| object-src   | `'none'`                                                            |
| media-src    | `'self'`                                                            |
| frame-src    | `'none'`                                                            |

**Rationale**: Prevents injection of inline scripts (`unsafe-inline` is forbidden), inline styles, and `eval()` (`unsafe-eval` is forbidden). Restricts resource loading to same-origin and approved schemes. Blocking `object-src` and `frame-src` eliminates Flash/embedding attack vectors. The `script-src-attr 'none'` directive blocks event-handler attributes (`onclick`, `onerror`, etc.) that could bypass `script-src`.

### `Strict-Transport-Security`

| Property          | Value                        |
|-------------------|------------------------------|
| max-age           | 31536000 (1 year)            |
| includeSubDomains | true                         |
| preload           | true                         |

**Rationale**: Forces all subsequent requests to use HTTPS, preventing SSL-stripping attacks. The `includeSubDomains` directive extends protection to all subdomains. The `preload` directive allows submission to browser preload lists, ensuring HTTPS is used even on the first visit.

### `Referrer-Policy`

| Property | Value                          |
|----------|--------------------------------|
| policy   | `strict-origin-when-cross-origin` |

**Rationale**: Strips the origin and path from cross-origin referrer headers, preventing leakage of sensitive query parameters (API keys, session tokens) to third-party origins while still sending the origin for same-origin navigations.

### `Cross-Origin-Resource-Policy`

| Property | Value      |
|----------|------------|
| policy   | `same-origin` |

**Rationale**: Prevents cross-origin resource loading. Even if an attacker can trigger a request to a Credence endpoint, the browser will refuse to load the response as a resource (e.g., as a script or image) from a different origin, mitigating cross-origin data exfiltration.

### `X-Content-Type-Options`

| Value    |
|----------|
| `nosniff` |

**Rationale**: Prevents browsers from MIME-sniffing a response body away from the declared `Content-Type`. Without this, an attacker could upload a file with a benign extension containing executable JavaScript and trick the browser into executing it.

### `X-Powered-By` (removed)

| Action   |
|----------|
| Header is stripped |

**Rationale**: The `X-Powered-By` header reveals the underlying server technology. Removing it reduces the attack surface by not exposing implementation details to an attacker.

## Headers Intentionally Not Set

| Header                    | Value     | Rationale                                                                 |
|---------------------------|-----------|---------------------------------------------------------------------------|
| `Cross-Origin-Embedder-Policy` | not set | API-only service does not share resources cross-origin in a way that requires COEP. |
| `Cross-Origin-Opener-Policy`   | not set | No popup/window communication between origins.                             |
| `DNS-Prefetch-Control`         | not set | Not applicable for API-only responses.                                     |
| `X-Frame-Options`              | not set | CSP `frame-src 'none'` provides equivalent protection for API-only service. |
| `Permissions-Policy`           | not set | CSP `object-src 'none'` and `frame-src 'none'` provide equivalent control. |

## Negative Test

A negative test in `src/middleware/__tests__/securityHeaders.test.ts` verifies that responses missing required security headers are detected by the `securityHeadersCheck` middleware. The test simulates a response where the security headers middleware was bypassed and confirms the check middleware rejects the response with a typed `MissingSecurityHeaderError` rather than panicking or returning a generic 500.

## References

- [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/)
- [Helmet.js Documentation](https://helmetjs.github.io/)
- [CSP Evaluator](https://csp-evaluator.withgoogle.com/)
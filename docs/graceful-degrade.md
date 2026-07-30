# Graceful Degradation (Read-Only Mode)

The Credence API supports a graceful degradation mode (read-only mode) that can be triggered dynamically. This is useful for operators (ops) during system maintenance, database migrations, or infrastructure failover drills where write operations must be cleanly rejected without causing raw database or gateway errors.

## How it works

The `gracefulDegradeMiddleware` (implemented in `src/middleware/gracefulDegrade.ts`) intercepts incoming requests.

1. It checks the presence of the `X-Read-Only` header.
2. If the header is set to `'true'` or `'1'`, the middleware identifies whether the incoming HTTP method is a state-mutating write operation.
3. Write operations include:
   - `POST`
   - `PUT`
   - `PATCH`
   - `DELETE`
4. If the request is a write operation, it is cleanly rejected by throwing a `ServiceUnavailableError`, which translates to an HTTP `503 Service Unavailable` response with a structured JSON error payload.
5. If the request is a safe, read-only operation (such as `GET`, `HEAD`, or `OPTIONS`), it is allowed to pass through to the router.

## Error Response Format

When a write is rejected, the API returns a standard `503 Service Unavailable` response:

```json
{
  "error": "Writes are temporarily disabled due to maintenance",
  "code": "service_unavailable",
  "error_code": "service_unavailable"
}
```

## Operator Usage (Runbook)

### Load Balancer / Gateway Injection

Operators can enable read-only mode by configuring the ingress proxy, API gateway (e.g. Kong, Envoy, NGINX), or CDN to inject the `X-Read-Only: true` header for all requests routed to the backend during the maintenance window.

For example, in NGINX, this can be done using the `proxy_set_header` directive:

```nginx
location /api {
    proxy_set_header X-Read-Only "true";
    proxy_pass http://backend;
}
```

### Manual Testing

You can manually verify that writes are rejected and reads are allowed using `curl`:

**Read Request (GET):**
```bash
curl -i -H "X-Read-Only: true" http://localhost:3000/api/health
# Should return HTTP 200 OK
```

**Write Request (POST):**
```bash
curl -i -H "X-Read-Only: true" -X POST http://localhost:3000/api/trust
# Should return HTTP 503 Service Unavailable
```

## Testing

The test suite covers:
- Verification of GET requests (allowed with/without header)
- Verification of POST, PUT, PATCH, DELETE requests (blocked with header, allowed without)
- Handling of different header values (`true`, `1`, `false`, other strings)

To run the middleware tests:

```bash
npx vitest run src/middleware/__tests__/gracefulDegrade.test.ts
```

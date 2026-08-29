# Echo endpoint

The unauthenticated `GET /api/v1/echo` endpoint is provided for connectivity and proxy diagnostics.

It returns the request headers in a JSON response:

```json
{
  "headers": {
    "accept": "*/*",
    "x-connectivity-test": "echo-value"
  }
}
```

Header names are normalized to lowercase by Express. Header values are returned as strings or arrays of strings, matching the incoming request representation.

Example:

```bash
curl -i \
  -H 'X-Connectivity-Test: echo-value' \
  https://example.com/api/v1/echo
```

This endpoint intentionally does not require an `Authorization` header and should only be used for connectivity testing and diagnostics.

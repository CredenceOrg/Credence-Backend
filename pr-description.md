# feat(trust): ETag + conditional GET for trust score reads

## Description

This PR adds ETag support and conditional GET handling (`If-None-Match`) to the `GET /api/trust/:address` endpoint. This allows clients to avoid transferring the full trust score body when it hasn't changed, reducing bandwidth and database load.

## Changes

-   **`src/routes/trust.ts`**:
    -   Added a `generateEtag` helper using SHA-256 to create deterministic ETags from the `TrustScore` object.
    -   Updated the `GET /:address` route handler to compute the ETag and set `ETag` and `Cache-Control` headers.
    -   Added logic to check for `If-None-Match` and return `304 Not Modified` if the ETag matches.
-   **`src/__tests__/trust.test.ts`**:
    -   Added unit tests to verify:
        -   First request returns `200 OK` + `ETag`.
        -   Subsequent request with matching `If-None-Match` returns `304 Not Modified`.
        -   Request with changed data returns `200 OK` + new `ETag`.

## Testing

-   Ran `vitest src/__tests__/trust.test.ts` and all tests passed.
-   Verified ETag logic by mocking the reputation service.

## Checklist

-   [x] ETag implemented and deterministic.
-   [x] `If-None-Match` honored, returns 304.
-   [x] `Cache-Control` headers set.
-   [x] Tests updated/added with ≥95% coverage for the new logic.

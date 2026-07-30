# API & Endpoint Deprecation Policy

**Audience:** Downstream integrators (API clients, SDK consumers, webhook subscribers)

This policy outlines how the Credence Backend service manages the lifecycle of deprecated REST API endpoints, fields, request parameters, and webhook payloads. It defines our support timelines, communication schedule (cadence), and machine-readable deprecation signals so downstream integrators can plan migrations with confidence.

---

## 1. Deprecation Support Window

When an API feature, endpoint, or field is marked for replacement or removal, Credence Backend provides a **minimum 6-month (180-day) support window** before hard removal.

| Support Phase | Duration | Service & API Behavior |
|---------------|----------|------------------------|
| **Active & Deprecated** | Minimum 6 months | The deprecated endpoint/field remains fully operational, tested, and supported in production alongside its replacement. |
| **Sunset & Removed** | Target next MAJOR release | The deprecated endpoint/field is permanently removed in the next MAJOR version bump (e.g., `v1.x` → `v2.0`). Calls after removal return HTTP `410 Gone` or `404 Not Found`. |

### Key Guarantees for Integrators

1. **No Unexpected Breaking Changes:** Endpoints and fields will never be removed or undergo breaking structural changes without completing the full 6-month deprecation period.
2. **Side-by-Side Coexistence:** New replacement endpoints/fields are introduced in a MINOR release (`v1.x`) at the start of the deprecation window, allowing downstream code to migrate incrementally.
3. **SemVer Compliance:** Deprecated features are only physically removed in MAJOR releases (`v2.0.0`, `v3.0.0`).

---

## 2. Communication Cadence

We communicate deprecations across multiple channels according to a structured timeline to ensure all downstream teams are notified well before any sunset date.

```
T-6 Months (Announcement) ───► T-3 Months (Midpoint Alert) ───► T-1 Month (Final Notice) ───► T-0 (Sunset & Removal)
  • GitHub Issue (deprecation)   • Log metrics evaluation       • Final release note reminder   • Removed in MAJOR release
  • OpenAPI spec updated         • Secondary GitHub update      • Webhook contact outreach      • HTTP 410 / 404
  • HTTP Response Headers added
```

### Communication Milestones

#### Milestone 0: Announcement (T-6 Months / Day 0)
* **GitHub Issue:** A GitHub issue labeled `deprecation` is created in `CredenceOrg/Credence-Backend` detailing:
  * Affected endpoint or schema field (e.g., `bondedAmount` in `GET /api/trust/:address`).
  * Recommended replacement (e.g., `bondAmountWei`).
  * Migration guide reference link.
  * Planned removal version (e.g., `v2.0.0`) and sunset timestamp.
* **Release Notes:** Listed under a prominent **Deprecations & Breaking Changes** section in the MINOR release notes (e.g., `v1.5.0`).
* **OpenAPI Specification:** The operation or property in `docs/openapi.yaml` is updated with `deprecated: true` and an explanatory description.
* **HTTP Deprecation Headers:** All responses from the deprecated route begin serving standardized deprecation headers (RFC 8594 / IETF draft).

#### Milestone 1: Midpoint Review (T-3 Months / Day 90)
* **Discussions & Progress Check:** Maintainers review telemetry for endpoint usage and post a progress update on the GitHub deprecation issue.
* **SDK Warning Annotations:** The `@credence/sdk` client package emits compile-time `@deprecated` annotations pointing to the replacement methods.

#### Milestone 2: Final Notice (T-1 Month / Day 150)
* **Direct Outreach & Final Reminders:** A final reminder is included in pre-release notes for the preceding PATCH/MINOR version.
* **Integration Health Warning:** Integration sandbox environments log high-visibility warning logs for remaining traffic targeting deprecated routes.

#### Milestone 3: Sunset & Removal (T-0 / Day 180+)
* **MAJOR Release Removal:** The deprecated endpoint or field is completely removed in the next MAJOR release.

---

## 3. Concrete HTTP Header & Response Examples

Downstream integrators can programmatically detect deprecations using HTTP response headers emitted on every request to a deprecated endpoint.

### Real Request & Response Example

**Request:**
```http
GET /api/trust/0x742d35Cc6634C0532925a3b844Bc454e4438f44e HTTP/1.1
Host: api.credence.network
Accept: application/json
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Deprecation: true
Sunset: Wed, 01 Sep 2026 00:00:00 GMT
Link: <https://github.com/CredenceOrg/Credence-Backend/issues/822>; rel="deprecation"
X-Credence-Version: 0.1.0

{
  "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "trustScore": 85,
  "status": "active",
  "bondedAmount": "1000000000000000000",
  "bondAmountWei": "1000000000000000000"
}
```

### Standardized Response Headers

| Header Name | Format / Example | Description |
|-------------|------------------|-------------|
| `Deprecation` | `true` or `@1788220800` | Indicates that the endpoint or payload shape is deprecated. |
| `Sunset` | `Wed, 01 Sep 2026 00:00:00 GMT` | HTTP date specifying the exact date after which the endpoint will be removed. |
| `Link` | `<https://github.com/.../issues/822>; rel="deprecation"` | Link header targeting the GitHub deprecation issue and migration guide. |

---

## 4. Discoverability & OpenAPI Integration

Deprecations are machine-readable in our published OpenAPI 3.0 specification (`docs/openapi.yaml`).

### Example OpenAPI Schema Entry

```yaml
/api/trust/{address}:
  get:
    summary: Get trust score and bond details
    deprecated: true
    description: >
      DEPRECATED: Use /api/verification/{address} for unified trust proofs.
      Scheduled for removal in v2.0.0 (Sunset: 2026-09-01).
      See https://github.com/CredenceOrg/Credence-Backend/issues/822.
    responses:
      '200':
        description: Successful response
        headers:
          Deprecation:
            schema:
              type: string
            example: "true"
          Sunset:
            schema:
              type: string
            example: "Wed, 01 Sep 2026 00:00:00 GMT"
```

---

## 5. Downstream Integrator Checklist

To avoid service disruptions, downstream developers should follow this integration checklist:

- [ ] **Monitor Headers:** Inspect API responses in client middleware for the presence of `Deprecation: true` and log `Sunset` dates.
- [ ] **Subscribe to Notifications:** Watch the `CredenceOrg/Credence-Backend` repository and filter issues by the `deprecation` label.
- [ ] **Audit SDK Code:** Resolve TypeScript compiler warnings regarding `@deprecated` SDK functions.
- [ ] **Pin API Specs:** Reference specific versions of `docs/openapi.yaml` when auto-generating client SDKs.
- [ ] **Test Migrations Early:** Switch to new fields/endpoints during the 6-month window before `Sunset` dates take effect.

---

## 6. Related Documents

- **[API Stability & Versioning Policy](API_STABILITY.md):** Full SemVer breakdown and breaking change definitions.
- **[API Reference](api.md):** Active REST API endpoints and error handling.
- **[OpenAPI Specification Guide](OPENAPI.md):** How OpenAPI specs are generated and updated.
- **[Documentation Index](README.md):** Overview of all project documentation.

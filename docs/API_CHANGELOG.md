# API Change Log

**Audience:** Contributors adding or modifying API endpoints, request/response shapes, or webhook payloads.

This is the single source of truth for every API change in the Credence Backend. Each entry records what changed, the impact on existing consumers, and the release where it takes effect. Reviewers use it to verify behaviour against documented intent; support uses it to answer common questions without paging an engineer.

---

## Entry format

Every entry must include these fields. Omitting required fields is the most common review failure.

```markdown
### <YYYY-MM-DD> — <Brief description>

**Impact:** <breaking | backward-compatible | deprecation>
**Related issue:** #<number>
**OpenAPI spec:** docs/openapi.yaml
**Zod schema:** src/schemas/<file>.ts

**What changes**

<1–2 sentences describing the change. State the endpoint, field, or event affected.>

**Request shape**

```json
{
  "<field>": "<example value>"
}
```

**Response shape**

```json
{
  "<field>": "<example value>"
}
```

**Migration steps** (required for breaking changes; omit for backward-compatible additions)

1. <Step 1>
2. <Step 2>
```

---

## Worked example

### 2026-07-28 — Add `agreedFields` to trust score response

**Impact:** backward-compatible
**Related issue:** #820
**OpenAPI spec:** docs/openapi.yaml
**Zod schema:** src/schemas/trust.ts

**What changes**

A new optional field `agreedFields` is added to the response of `GET /api/trust/:address`. Existing clients are unaffected because the field is optional and defaults to an empty array when absent.

**Request shape**

```json
{
  "address": "GAIQ...XPQ"
}
```

**Response shape**

```json
{
  "address": "GAIQ...XPQ",
  "score": 87,
  "agreedFields": ["name", "email"]
}
```

**Migration steps**

None required. The field is optional and backward-compatible.

---

## Entry log

<!-- Entries are appended below in reverse chronological order. -->

### 2026-07-28 — Add `agreedFields` to trust score response

**Impact:** backward-compatible
**Related issue:** #820
**OpenAPI spec:** docs/openapi.yaml
**Zod schema:** src/schemas/trust.ts

**What changes**

A new optional field `agreedFields` is added to the response of `GET /api/trust/:address`. Existing clients are unaffected because the field is optional and defaults to an empty array when absent.

**Request shape**

```json
{
  "address": "GAIQ...XPQ"
}
```

**Response shape**

```json
{
  "address": "GAIQ...XPQ",
  "score": 87,
  "agreedFields": ["name", "email"]
}
```

**Migration steps**

None required. The field is optional and backward-compatible.

---

## How to use this log

1. **Before merging an API change**, add an entry using the format above.
2. **Regenerate the OpenAPI spec** after updating Zod schemas:
   ```bash
   npm run generate:openapi
   ```
3. **Reviewers** verify that the entry's request/response shapes match the actual code and the regenerated `docs/openapi.yaml`.
4. **Support teams** reference this log when answering "what changed?" questions.

## Related docs

- **[API Stability & Versioning](API_STABILITY.md)** — what constitutes a breaking vs. backward-compatible change
- **[API & Endpoint Deprecation Policy](DEPRECATION_POLICY.md)** — how to deprecate endpoints over a 6-month window
- **[OpenAPI Spec Guide](OPENAPI.md)** — how to regenerate `docs/openapi.yaml` from Zod schemas
- **[Input Validation Guide](INPUT_VALIDATION.md)** — how request shapes are validated with Zod
# Input Validation Guide

This guide explains how we validate request inputs (path parameters, query strings, and JSON bodies) and how those validation errors are surfaced to API clients.

**Audience**: Contributors adding new endpoints or modifying existing request shapes.

## Core Concepts

We use [Zod](https://zod.dev/) for all runtime validation. Zod schemas provide two main benefits:
1. **Runtime safety**: Rejecting malformed requests before they reach your route handler.
2. **Type safety**: Automatically inferring TypeScript types from schemas, so you don't have to define types twice.

### Where schemas live

Place your validation schemas in `src/schemas/`. Do not define schemas inline within route files, as they are often reused across the codebase (e.g., for OpenAPI generation or shared types).

## Example: Defining a Schema

Here is a concrete example of defining a request body schema for inviting a member.

```typescript
// src/schemas/admin.ts
import { z } from 'zod'

/**
 * Request body schema for inviting a member to an organization
 * POST /api/admin/orgs/:orgId/members
 */
export const inviteMemberBodySchema = z
  .object({
    userId: z.string().min(1, 'userId is required'),
    email: z.string().email('email must be a valid email address'),
    role: z
      .enum(['owner', 'admin', 'member'] as const)
      .optional(),
  })
  .strict() // Prevents unexpected keys in the body

// Export the inferred type for use in handlers or internal services
export type InviteMemberBody = z.infer<typeof inviteMemberBodySchema>
```

## Example: Using the Middleware

To enforce the schema, use the `validate` middleware in your route definition. The middleware accepts an options object with `params`, `query`, and `body` keys.

```typescript
// src/routes/admin/index.ts
import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { inviteMemberBodySchema } from '../../schemas/admin.js'

const router = Router()

router.post(
  '/orgs/:orgId/members',
  validate({
    body: inviteMemberBodySchema,
    // You can also provide `params` and `query` schemas here
  }),
  (req, res, next) => {
    // Due to the middleware, req.validated.body is fully typed and safe to use.
    // It is typed as InviteMemberBody.
    const { userId, email, role } = req.validated.body
    
    // Process request...
  }
)
```

## Error Surfacing

When validation fails, the `validate` middleware catches the `ZodError` and maps it using `formatZodErrors` into a standardized format. The middleware then calls `next(new ValidationError(...))` to hand control over to the global error handler.

### Standardized Error Format

Clients receive a `400 Bad Request` with a JSON payload that includes the validation issues. We map specific Zod error codes to our internal `ErrorCode` enum (e.g., `VALIDATION_FAILED`, `INVALID_ADDRESS`, `FIELD_REQUIRED`).

An example response for a failed `inviteMemberBodySchema` validation:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      {
        "path": "email",
        "message": "email must be a valid email address",
        "code": "INVALID_FORMAT"
      },
      {
        "path": "role",
        "message": "Invalid enum value. Expected 'owner' | 'admin' | 'member', received 'guest'",
        "code": "INVALID_TYPE"
      }
    ]
  }
}
```

### Tips
- Always use `.strict()` on object schemas to prevent unhandled extra fields.
- Always provide descriptive custom error messages in `.min(1, 'message')` or `.email('message')` to improve the client experience.

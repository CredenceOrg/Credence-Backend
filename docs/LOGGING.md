# Structured Logging Policy

This document outlines the logging standards for contributors to the Credence backend. We rely on structured, JSON-formatted logs to ensure our operations team can effectively filter, monitor, and debug production issues.

## Core Principles

1.  **Always use the structured logger.** Avoid `console.log` or `console.error`.
2.  **Log context, not prose.** Let the message be a simple, searchable event name or action, and put variable data in the JSON payload.
3.  **Protect PII.** Never log sensitive user data in plain text.

## Reserved Keys

To maintain a consistent schema across all services, the following keys are reserved at the root of the log payload. If you need to log this information, use exactly these keys:

*   **`request_id`** (string): The unique identifier for the incoming HTTP request. This should be propagated to all child logs.
*   **`tenant`** (string): The identifier of the customer or tenant account making the request.
*   **`actor`** (string): The identifier of the specific user, service account, or API key performing the action.

### Example: A well-formed log entry

```typescript
import { logger } from '../utils/logger'; // Use the project's configured logger

// Good: Action is the message, data is in the payload using reserved keys
logger.info('bond_withdrawal_initiated', {
  request_id: 'req_123abc',
  tenant: 'org_456def',
  actor: 'user_789ghi',
  bond_id: 'bond_001',
  amount_withdrawn: 500
});

// Bad: Interpolated strings are hard to search and alert on
logger.info(`User user_789ghi withdrew 500 from bond_001 (req: req_123abc)`);
```

## PII Redaction Rules

We must never store Personally Identifiable Information (PII) or secrets in our logging aggregator. 

**Never log:**
*   Email addresses
*   Passwords or API keys
*   Full names
*   IP addresses (unless explicitly required for an audit event, in which case they must be hashed or stored in a dedicated secure audit log)
*   OAuth tokens or JWTs

### Redaction Example

If you receive a payload that contains PII, you must sanitize it before logging.

```typescript
import { logger } from '../utils/logger';

function processUserUpdate(payload: any, reqId: string) {
  // Redact PII before logging the payload
  const safePayload = {
    ...payload,
    email: '[REDACTED]',
    password: '[REDACTED]'
  };

  logger.info('user_profile_updated', {
    request_id: reqId,
    actor: payload.user_id,
    updates: safePayload
  });
}
```

By following these rules, we ensure that our logs remain a powerful and secure tool for the entire team.

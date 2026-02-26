# Admin API Documentation

## Overview

The Admin API provides endpoints for administrative user and role management, including:
- Listing users with pagination and filtering
- Assigning and revoking roles
- Managing API keys
- Comprehensive audit logging of all admin actions

All admin endpoints require authentication with an admin bearer token and enforce role-based access control (RBAC).

## Authentication

All admin endpoints require Bearer token authentication via the `Authorization` header:

```
Authorization: Bearer <admin-api-key>
```

### Admin Tokens

Admin users must authenticate using their API key as a Bearer token:

```bash
Authorization: Bearer admin-key-12345
```

### Authorization

All endpoints require the user to have the `admin` role. Non-admin users will receive a `403 Forbidden` response.

## Response Format

All endpoints return JSON responses with the following structure:

### Success Response

```json
{
  "success": true,
  "data": {
    // endpoint-specific data
  },
  "message": "Optional success message"
}
```

### Error Response

```json
{
  "error": "ErrorCode",
  "message": "Human-readable error message"
}
```

## Endpoints

### List Users

**GET** `/api/admin/users`

List all users with pagination and optional filtering.

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Number of results per page (max 100) |
| `offset` | number | 0 | Pagination offset |
| `role` | string | - | Filter by role: `admin`, `verifier`, `user` |
| `active` | boolean | - | Filter by active status: `true` or `false` |

#### Example Request

```bash
curl -X GET 'http://localhost:3000/api/admin/users?limit=10&offset=0&role=verifier' \
  -H "Authorization: Bearer admin-key-12345"
```

#### Example Response (200 OK)

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "verifier-user-1",
        "email": "verifier@credence.org",
        "role": "verifier",
        "apiKey": "verifier-key-67890",
        "createdAt": "2025-01-25T10:00:00.000Z",
        "lastActivity": "2026-02-25T12:30:45.123Z",
        "active": true
      }
    ],
    "total": 1,
    "limit": 10,
    "offset": 0
  }
}
```

#### Error Responses

- **401 Unauthorized** - Missing or invalid Bearer token
- **403 Forbidden** - User does not have admin role
- **400 Bad Request** - Invalid pagination parameters or invalid role filter

---

### Assign Role

**POST** `/api/admin/roles/assign`

Assign or change a user's role. The user's previous role is replaced with the new role.

#### Request Body

```json
{
  "userId": "user-id",
  "role": "admin|verifier|user"
}
```

#### Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | Yes | ID of the target user |
| `role` | string | Yes | New role: `admin`, `verifier`, or `user` |

#### Example Request

```bash
curl -X POST http://localhost:3000/api/admin/roles/assign \
  -H "Authorization: Bearer admin-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "verifier-user-1",
    "role": "admin"
  }'
```

#### Example Response (200 OK)

```json
{
  "success": true,
  "message": "Role updated from verifier to admin",
  "data": {
    "id": "verifier-user-1",
    "email": "verifier@credence.org",
    "role": "admin",
    "apiKey": "verifier-key-67890",
    "createdAt": "2025-01-25T10:00:00.000Z",
    "lastActivity": "2026-02-25T12:30:45.123Z",
    "active": true
  }
}
```

#### Error Responses

- **400 Bad Request** - Missing required fields, invalid role, or user not found
- **401 Unauthorized** - Missing or invalid Bearer token
- **403 Forbidden** - User does not have admin role

#### Audit Logging

This action is logged with:
- **Action**: `ASSIGN_ROLE`
- **Details**: Old role and new role
- **Status**: `success` or `failure`

---

### Revoke API Key

**POST** `/api/admin/keys/revoke`

Revoke an API key for a user and issue a new replacement key. The old key is invalidated immediately.

#### Request Body

```json
{
  "userId": "user-id",
  "apiKey": "api-key-to-revoke"
}
```

#### Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | Yes | ID of the target user |
| `apiKey` | string | Yes | Current API key to revoke |

#### Example Request

```bash
curl -X POST http://localhost:3000/api/admin/keys/revoke \
  -H "Authorization: Bearer admin-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "verifier-user-1",
    "apiKey": "verifier-key-67890"
  }'
```

#### Example Response (200 OK)

```json
{
  "success": true,
  "message": "API key revoked and replaced. New key issued."
}
```

#### Error Responses

- **400 Bad Request** - Missing required fields, user not found, or API key doesn't belong to user
- **401 Unauthorized** - Missing or invalid Bearer token
- **403 Forbidden** - User does not have admin role

#### Audit Logging

This action is logged with:
- **Action**: `REVOKE_API_KEY`
- **Details**: Revoked key and new key generated
- **Status**: `success` or `failure`

#### Security Notes

- The old API key is immediately invalidated
- A new API key is automatically generated and must be communicated to the user securely
- Old tokens cannot be re-authenticated
- This action should be used when an API key is compromised or needs rotation

---

### Get Audit Logs

**GET** `/api/admin/audit-logs`

Retrieve audit logs of admin actions with pagination and filtering.

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Results per page (max 100) |
| `offset` | number | 0 | Pagination offset |
| `action` | string | - | Filter by action: LIST_USERS, ASSIGN_ROLE, REVOKE_API_KEY, etc. |
| `adminId` | string | - | Filter by admin user ID |
| `targetUserId` | string | - | Filter by target user ID |
| `status` | string | - | Filter by status: `success` or `failure` |

#### Example Request

```bash
curl -X GET 'http://localhost:3000/api/admin/audit-logs?action=ASSIGN_ROLE&limit=20&offset=0' \
  -H "Authorization: Bearer admin-key-12345"
```

#### Example Response (200 OK)

```json
{
  "success": true,
  "data": {
    "logs": [
      {
        "id": "audit-0",
        "timestamp": "2026-02-25T12:30:45.123Z",
        "adminId": "admin-user-1",
        "adminEmail": "admin@credence.org",
        "action": "ASSIGN_ROLE",
        "targetUserId": "verifier-user-1",
        "targetUserEmail": "verifier@credence.org",
        "details": {
          "oldRole": "verifier",
          "newRole": "admin"
        },
        "status": "success"
      }
    ],
    "total": 1
  }
}
```

#### Error Responses

- **400 Bad Request** - Invalid pagination parameters
- **401 Unauthorized** - Missing or invalid Bearer token
- **403 Forbidden** - User does not have admin role

---

## User Roles

The system supports three user roles with different permission levels:

| Role | Description | Permissions |
|------|-------------|-------------|
| `admin` | Administrator | Full access to admin API, manage users and roles, revoke keys, view audit logs |
| `verifier` | Verifier | Can verify identities and attestations (limited permissions) |
| `user` | Regular User | Basic access to read-only endpoints |

---

## Audit Logging

All admin actions are automatically logged for compliance and security purposes.

### Audit Log Entry Structure

```typescript
{
  id: string                        // Unique audit log ID
  timestamp: string                 // ISO 8601 timestamp
  adminId: string                   // ID of admin performing action
  adminEmail: string                // Email of admin performing action
  action: string                    // Action type (LIST_USERS, ASSIGN_ROLE, etc.)
  targetUserId: string              // ID of affected user
  targetUserEmail: string           // Email of affected user
  details: Record<string, unknown>  // Action-specific details
  ipAddress?: string                // IP address of request (optional)
  status: 'success' | 'failure'     // Action result
  errorMessage?: string             // Error message if status is 'failure'
}
```

### Audit Actions

| Action | Description |
|--------|-------------|
| `LIST_USERS` | User list retrieved |
| `ASSIGN_ROLE` | Role assigned to user |
| `REVOKE_ROLE` | Role revoked from user |
| `REVOKE_API_KEY` | API key revoked |
| `CREATE_API_KEY` | New API key created |
| `DELETE_USER` | User deleted |

---

## Error Codes

| Code | HTTP Status | Description |
|------|------------|-------------|
| `Unauthorized` | 401 | Missing or invalid authentication token |
| `Forbidden` | 403 | User lacks required permissions (e.g., admin role) |
| `InvalidRequest` | 400 | Missing or invalid request parameters |
| `BadRequest` | 400 | Business logic validation failed |
| `InternalError` | 500 | Unexpected server error |

---

## Rate Limiting

Rate limiting may be implemented in production. Current implementation has no rate limits.

---

## Pagination

All listing endpoints support cursor-based pagination:

- **limit**: Number of results (1-100, default 50)
- **offset**: Pagination offset starting at 0

### Pagination Example

```bash
# Get first 10 results
GET /api/admin/users?limit=10&offset=0

# Get next 10 results
GET /api/admin/users?limit=10&offset=10
```

---

## Best Practices

### Security

1. **Protect Admin Keys**: Store admin API keys securely (use environment variables, secret managers)
2. **Minimal Permissions**: Only grant admin role to necessary personnel
3. **Key Rotation**: Revoke and regenerate API keys regularly
4. **Audit Monitoring**: Regularly review audit logs for suspicious activities
5. **HTTPS Only**: Always use HTTPS in production

### Usage

1. **Batch Operations**: Use pagination when listing large user sets
2. **Error Handling**: Implement proper error handling in client applications
3. **Idempotency**: Some operations (like role assignment) are idempotent; re-running produces same result
4. **Logging**: Client applications should log admin API calls for debugging

---

## Testing

### Run Tests

```bash
npm run test
npm run test:coverage
```

### Test Coverage

The admin API includes comprehensive test coverage:
- Authentication and authorization (95%+ coverage)
- User listing with pagination and filtering
- Role assignment with validation
- API key revocation
- Audit logging
- Error scenarios

---

## Examples

### Complete Admin Workflow

```bash
#!/bin/bash
ADMIN_TOKEN="Bearer admin-key-12345"
BASE_URL="http://localhost:3000/api/admin"

# 1. List all verifiers
curl -X GET "${BASE_URL}/users?role=verifier" \
  -H "Authorization: ${ADMIN_TOKEN}"

# 2. Promote a verifier to admin
curl -X POST "${BASE_URL}/roles/assign" \
  -H "Authorization: ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"userId": "verifier-user-1", "role": "admin"}'

# 3. Revoke their old key for security
curl -X POST "${BASE_URL}/keys/revoke" \
  -H "Authorization: ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"userId": "verifier-user-1", "apiKey": "verifier-key-67890"}'

# 4. Review audit logs
curl -X GET "${BASE_URL}/audit-logs?adminId=admin-user-1" \
  -H "Authorization: ${ADMIN_TOKEN}"
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Missing/invalid token | Verify Bearer token format in Authorization header |
| 403 Forbidden | Non-admin user | Ensure user has admin role assigned |
| 400 Bad Request | Invalid parameters | Check request body and query parameters |
| User not found | Invalid user ID | Verify user ID exists in system |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-25 | Initial release |

---

## Support

For issues or questions about the Admin API:
1. Check the troubleshooting section above
2. Review audit logs for detailed action history
3. Examine test cases in `src/__tests__/admin.test.ts` for usage examples

# Credence API Reference

- OpenAPI spec: [`docs/openapi.yaml`](openapi.yaml)
- Postman collection: [`docs/credence.postman_collection.json`](credence.postman_collection.json)

---

## Base URL

| Environment       | URL                                   |
| ----------------- | ------------------------------------- |
| Local development | `http://localhost:3000`               |
| Production        | _(configured via `BASE_URL` env var)_ |

---

## Authentication

All endpoints are publicly readable. Supply an `X-API-Key` header to unlock
the **premium** rate tier.

```
X-API-Key: <your-key>
```

| Header present    | Tier     |
| ----------------- | -------- |
| No                | standard |
| Yes (valid key)   | premium  |
| Yes (invalid key) | standard |

---

## Address format

All `:address` path parameters must be Ethereum addresses:
`0x` followed by exactly 40 hexadecimal characters.
Accepted in any case (EIP-55 checksummed or all lower-case).

**Valid:** `0xf39Fd6e51aad88F6f4ce6aB8827279cffFb92266`
**Invalid:** `0x1234`, `f39fd6...` (no `0x` prefix), `not-an-address`

---

## Endpoints

### `GET /api/health`

Returns service liveness.

```
GET /api/health
```

**Response `200`**

```json
{
  "status": "ok",
  "service": "credence-backend"
}
```

---

### `GET /api/trust/:address`

Returns the computed trust score and identity data for an Ethereum address.

```
GET /api/trust/:address
```

**Score algorithm**

The score is an integer `[0, 100]` built from three components:

| Component     | Max pts | Maxes when        |
| ------------- | ------- | ----------------- |
| Bond amount   | 50      | ≥ 1 ETH bonded    |
| Bond duration | 20      | bonded ≥ 365 days |
| Attestations  | 30      | ≥ 5 attestations  |

**Path parameters**

| Param     | Description                            |
| --------- | -------------------------------------- |
| `address` | Ethereum address (`0x` + 40 hex chars) |

**Headers (optional)**

| Header      | Description                   |
| ----------- | ----------------------------- |
| `X-API-Key` | API key for premium rate tier |

**Responses**

| Status | Condition                                 |
| ------ | ----------------------------------------- |
| `200`  | Identity found; returns TrustScore object |
| `400`  | Address format invalid                    |
| `404`  | No identity record for this address       |

**`200` example — fully bonded identity**

```json
{
  "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "score": 100,
  "bondedAmount": "1000000000000000000",
  "bondStart": "2024-01-15T00:00:00.000Z",
  "attestationCount": 5,
  "agreedFields": {
    "name": "Alice",
    "role": "validator"
  }
}
```

**`200` example — unbonded identity (score 0)**

```json
{
  "address": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "score": 0,
  "bondedAmount": "0",
  "bondStart": null,
  "attestationCount": 0
}
```

**`400` example**

```json
{
  "error": "Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters."
}
```

**`404` example**

```json
{
  "error": "No identity record found for address 0x1234567890123456789012345678901234567890."
}
```

**Response fields**

| Field              | Type                | Description                                |
| ------------------ | ------------------- | ------------------------------------------ |
| `address`          | string              | Normalised lower-case address              |
| `score`            | integer 0–100       | Computed trust score                       |
| `bondedAmount`     | string (bigint wei) | Amount bonded                              |
| `bondStart`        | string \| null      | ISO 8601 bond timestamp                    |
| `attestationCount` | integer             | Number of attestations                     |
| `agreedFields`     | object?             | Attested key/value pairs (omitted if none) |

**cURL examples**

```bash
# Standard tier
curl http://localhost:3000/api/trust/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

# Premium tier
curl -H "X-API-Key: my-key" \
  http://localhost:3000/api/trust/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

# Not found (valid address, no record)
curl http://localhost:3000/api/trust/0x1234567890123456789012345678901234567890

# Invalid address format
curl http://localhost:3000/api/trust/not-an-address
```

---

### `GET /api/bond/:address`

Returns bond status for an Ethereum address from the database.

```
GET /api/bond/:address
```

**Path parameters**

| Param     | Description                            |
| --------- | -------------------------------------- |
| `address` | Ethereum address (`0x` + 40 hex chars) |

**Headers (optional)**

| Header      | Description                   |
| ----------- | ----------------------------- |
| `X-API-Key` | API key for premium rate tier |

**Responses**

| Status | Condition                                    |
| ------ | -------------------------------------------- |
| `200`  | Bond record found; returns BondStatus object |
| `400`  | Address format invalid                       |
| `404`  | No bond record for this address              |

**`200` example — active bond**

```json
{
  "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "bondedAmount": "1000000000000000000",
  "bondStart": "2024-01-15T00:00:00.000Z",
  "bondDuration": 31536000,
  "active": true,
  "slashedAmount": "0"
}
```

**`200` example — inactive / no bond**

```json
{
  "address": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "bondedAmount": "0",
  "bondStart": null,
  "bondDuration": null,
  "active": false,
  "slashedAmount": "0"
}
```

**`400` example**

```json
{
  "error": "Invalid address format. Expected an Ethereum address: 0x followed by 40 hex characters."
}
```

**`404` example**

```json
{
  "error": "No bond record found for address 0x1234567890123456789012345678901234567890."
}
```

**Response fields**

| Field           | Type                | Description                          |
| --------------- | ------------------- | ------------------------------------ |
| `address`       | string              | Normalised lower-case address        |
| `bondedAmount`  | string (bigint wei) | Currently bonded amount              |
| `bondStart`     | string \| null      | ISO 8601 bond start timestamp        |
| `bondDuration`  | integer \| null     | Bond duration in seconds             |
| `active`        | boolean             | Whether the bond is currently active |
| `slashedAmount` | string (bigint wei) | Total amount slashed from this bond  |

**cURL examples**

```bash
# Active bond
curl http://localhost:3000/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

# Not found (valid address, no record)
curl http://localhost:3000/api/bond/0x1234567890123456789012345678901234567890

# Invalid address format
curl http://localhost:3000/api/bond/not-an-address
```

---

## Error format

All errors follow this shape:

```json
{ "error": "Human-readable description of what went wrong." }
```

---

## Importing the Postman collection

### Option A – Postman desktop / web

1. Open **Postman** and go to **Import** (top-left or File → Import).
2. Select **File** and choose `docs/credence.postman_collection.json`.
3. Click **Import**.
4. The **Credence API** collection appears in the left sidebar.

**Set environment variables:**

The collection ships with three built-in variables. Edit them via the
collection's **Variables** tab (click the collection name → Variables):

| Variable  | Default                 | Change to                                    |
| --------- | ----------------------- | -------------------------------------------- |
| `baseUrl` | `http://localhost:3000` | Your staging/production URL                  |
| `apiKey`  | _(empty)_               | Your API key (leave blank for standard tier) |
| `address` | `0xf39fd...2266`        | Any valid address you want to query          |

### Option B – Insomnia

Insomnia can import Postman v2.1 collections directly:

1. Open **Insomnia** and go to **File → Import**.
2. Select `docs/credence.postman_collection.json`.
3. Choose **Import as: Request Collection**.
4. Click **Import**.

After importing, set `baseUrl` and `apiKey` in your active environment
(**Manage Environments → Base Environment**).

### Option C – Newman (CLI runner)

Run the full collection from the terminal without the Postman desktop app:

```bash
# Install Newman globally
npm install -g newman

# Run the collection
newman run docs/credence.postman_collection.json \
  --env-var "baseUrl=http://localhost:3000" \
  --env-var "apiKey=your-key-here"
```

---

## Viewing the OpenAPI spec

The spec at `docs/openapi.yaml` is valid OpenAPI 3.1.0 and can be rendered
by any compatible tool:

```bash
# Swagger UI via npx (no install required)
npx @redocly/cli preview-docs docs/openapi.yaml

# Or with Stoplight Prism (mock server + validation)
npx @stoplight/prism-cli mock docs/openapi.yaml
```

Alternatively, paste the file contents into [editor.swagger.io](https://editor.swagger.io) or [readme.com](https://readme.com).

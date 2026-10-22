# RemitLend API Reference

Comprehensive documentation for the RemitLend Backend API v1 endpoints. This document serves as a standalone reference for all publicly available endpoints, authentication methods, request/response formats, and error handling.

## Table of Contents

- [Overview](#overview)
- [Base URLs](#base-urls)
- [Authentication](#authentication)
- [Common Response Format](#common-response-format)
- [Error Codes](#error-codes)
- [Rate Limiting](#rate-limiting)
- [Endpoints](#endpoints)
  - [Authentication](#authentication-endpoints)
  - [Loans](#loans-endpoints)
  - [User](#user-endpoints)
  - [Pool](#pool-endpoints)
  - [Scoring](#scoring-endpoints)
  - [Indexer](#indexer-endpoints)
  - [Admin](#admin-endpoints)
  - [Remittances](#remittances-endpoints)
  - [Notifications](#notifications-endpoints)
  - [System](#system-endpoints)

---

## Overview

RemitLend Backend is an Express.js REST API that provides access to:

- **Loan Management**: Request, approve, repay, and manage loans on the Stellar blockchain
- **Credit Scoring**: Generate and retrieve credit scores based on transaction history
- **Lending Pools**: Access liquidity pools and pool configurations
- **User Profiles**: Manage user account data and preferences
- **Remittance Simulation**: Generate simulated remittance data for testing
- **Event Indexing**: Query blockchain events and transaction history
- **Notifications**: Subscribe to and manage webhook notifications

## Base URLs

- **Legacy (Deprecated)**: `https://api.remitlend.com/api`
- **Current (v1)**: `https://api.remitlend.com/api/v1`
- **User Routes**: `https://api.remitlend.com/user`

All new integrations should use the `/api/v1` base path.

## Authentication

### Bearer Token (JWT)

Used for user-authenticated requests (loans, user profiles, borrower-specific data).

**Header:**
```
Authorization: Bearer <JWT_TOKEN>
```

**How to Obtain:**
1. Call `/api/v1/auth/challenge` with your Stellar public key
2. Sign the returned message with your Stellar wallet
3. Call `/api/v1/auth/login` with the signed message to receive a JWT token

**Token Format:** Ed25519-signed JWT containing:
- `publicKey`: Your Stellar public key
- `role`: Account role (admin, borrower, lender)
- `scopes`: Array of permission scopes

**Token Expiration:** Tokens expire after 24 hours. Use `/api/v1/auth/refresh` to obtain a new token before expiration.

### API Key Authentication

Used for service-to-service requests and server-side operations.

**Header:**
```
x-api-key: <API_KEY>
```

**Available Scopes:**
- `admin:*` — Full administrative access
- `admin:loans` — Loan management
- `admin:pool` — Pool operations
- `admin:indexer` — Indexer operations
- `admin:scoring` — Scoring operations

## Common Response Format

All API responses follow a consistent JSON structure:

### Success Response (2xx)

```json
{
  "success": true,
  "data": {
    // Endpoint-specific data
  }
}
```

### Error Response (4xx, 5xx)

```json
{
  "success": false,
  "message": "Human-readable error message",
  "errors": [
    {
      "path": "body.publicKey",
      "message": "Public key is required"
    }
  ],
  "stack": "Error stack trace (development only)"
}
```

## Error Codes

| Status | Code | Description | Example |
|--------|------|-------------|---------|
| 400 | `ValidationError` | Request validation failed | Missing required field, invalid format |
| 400 | `BadRequestError` | Invalid request parameters | Incompatible loan amount with pool configuration |
| 401 | `UnauthorizedError` | Missing or invalid authentication | Missing Bearer token, JWT expired |
| 403 | `ForbiddenError` | Insufficient permissions | Attempting to access another user's loan |
| 404 | `NotFoundError` | Resource not found | Loan ID doesn't exist |
| 409 | `ConflictError` | Loan state conflict | Attempting to repay an already-repaid loan |
| 429 | `RateLimitError` | Rate limit exceeded | Too many login attempts |
| 500 | `InternalServerError` | Server error | Unexpected backend failure |
| 503 | `ServiceUnavailableError` | Service temporarily unavailable | Blockchain network degradation |

### Detailed Error Handling

- **Validation errors** return detailed `errors` array with field-level information
- **Authentication errors** include a `WWW-Authenticate` header
- **Rate limit errors** include `Retry-After` header with seconds to wait
- **Production errors** omit the `stack` field for security

## Rate Limiting

Rate limits are enforced per endpoint and IP address:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/auth/challenge` | 5 requests | 15 minutes |
| `/auth/login` | 3 requests | 15 minutes (per IP) |
| `/auth/login` | 10 requests | 1 hour (per public key) |
| `/auth/verify` | 60 requests | 1 minute |
| General endpoints | 1000 requests | 1 hour (per IP) |

**Rate Limit Headers:**
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1700000000
```

---

## Endpoints

### Authentication Endpoints

#### POST /api/v1/auth/challenge

Request a sign-in message for wallet authentication. Each request issues a new
five-minute challenge; the server persists hashed nonce/message values for
one-time redemption. POST requests require an `Idempotency-Key` header, but
challenge responses are not cached.

**Request:**
```json
{
  "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "nonce": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "timestamp": 1700000000000,
    "expiresIn": 300000,
    "message": "Sign this message to authenticate with RemitLend.\n\nNonce: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nTimestamp: 1700000000000\n\nThis request will expire in 5 minutes."
  }
}
```

**Errors:**
- `400 ValidationError` — Missing or invalid public key
- `429 RateLimitError` — Too many challenge requests
- `503 SERVICE_UNAVAILABLE` — Challenge persistence is unavailable

---

#### POST /api/v1/auth/login

Exchange a signed challenge for a JWT token. The server verifies the signature
and atomically consumes the exact issued challenge before returning a token.
POST requests require an `Idempotency-Key` header; login responses are not
cached, so retrying a consumed challenge requires a new challenge.

**Request:**
```json
{
  "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
  "message": "Sign this message to authenticate with RemitLend.\n\nNonce: abc123\nTimestamp: 1700000000000\n\nThis request will expire in 5 minutes.",
  "signature": "base64EncodedSignature="
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJFZDI1NTE5In0...",
    "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7"
  }
}
```

**Errors:**
- `400 ValidationError` — Missing or malformed challenge fields
- `401 INVALID_SIGNATURE` — Signature does not match the wallet/message
- `401 CHALLENGE_EXPIRED` — Challenge timestamp is outside its validity window
- `401 CHALLENGE_REPLAYED` — Challenge was not issued to this wallet or was already used
- `429 RateLimitError` — Too many login attempts
- `503 SERVICE_UNAVAILABLE` — Challenge persistence is unavailable; request a new challenge and retry

---

#### GET /api/v1/auth/verify

Verify the current JWT token and retrieve user info.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "role": "borrower",
    "scopes": ["loans:read", "loans:write"],
    "valid": true
  }
}
```

**Errors:**
- `401 UnauthorizedError` — Invalid or missing token

---

#### POST /api/v1/auth/logout

Revoke the current JWT token.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Token revoked successfully"
}
```

---

#### POST /api/v1/auth/refresh

Refresh an expiring or expired JWT token.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJFZDI1NTE5In0..."
  }
}
```

---

### Loans Endpoints

#### GET /api/v1/loans/config

Retrieve loan configuration and pool settings.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "minLoanAmount": "100",
    "maxLoanAmount": "10000",
    "interestRate": "0.05",
    "loanTermMonths": 12,
    "minCollateralRatio": "1.5",
    "pools": [
      {
        "poolId": "pool_123",
        "currency": "USDC",
        "available": "50000",
        "total": "100000",
        "utilization": "0.5"
      }
    ]
  }
}
```

---

#### GET /api/v1/loans/borrower/{borrower}

Get all loans for a borrower.

**Query Parameters:**
```
?status=active&limit=10&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
  "loans": [
    {
      "loanId": 123,
      "principal": "1000",
      "accruedInterest": "50.25",
      "totalRepaid": "200",
      "totalOwed": "850.25",
      "nextPaymentDeadline": "2024-02-01T00:00:00Z",
      "status": "active",
      "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
      "approvedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**Errors:**
- `404 NotFoundError` — Borrower not found

---

#### GET /api/v1/loans/{loanId}

Get detailed information for a specific loan.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "principal": "1000",
    "interestRate": "0.05",
    "totalRepaid": "200",
    "totalOwed": "850.25",
    "accruedInterest": "50.25",
    "nextPaymentDeadline": "2024-02-01T00:00:00Z",
    "status": "active",
    "createdAt": "2024-01-01T00:00:00Z",
    "approvedAt": "2024-01-01T00:00:00Z"
  }
}
```

**Errors:**
- `404 NotFoundError` — Loan not found
- `403 ForbiddenError` — Access denied

---

#### GET /api/v1/loans/{loanId}/amortization-schedule

Get the amortization schedule for a loan.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "schedule": [
      {
        "paymentNumber": 1,
        "dueDate": "2024-02-01T00:00:00Z",
        "principalPayment": "83.33",
        "interestPayment": "4.17",
        "totalPayment": "87.50",
        "balanceRemaining": "916.67"
      }
    ]
  }
}
```

---

#### POST /api/v1/loans/request

Request a new loan.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "1000",
  "term": 12,
  "collateral": "500",
  "poolId": "pool_123"
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "loanId": 124,
    "transactionHash": "tx123...",
    "status": "pending_approval"
  }
}
```

**Errors:**
- `400 BadRequestError` — Invalid loan amount or term
- `401 UnauthorizedError` — Missing authentication
- `409 ConflictError` — Insufficient collateral

---

#### POST /api/v1/loans/{loanId}/repay

Make a loan repayment.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "200",
  "transactionHash": "tx789..."
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "newBalance": "650.25",
    "nextPaymentDeadline": "2024-03-01T00:00:00Z"
  }
}
```

**Errors:**
- `404 NotFoundError` — Loan not found
- `409 ConflictError` — Loan already repaid

---

#### POST /api/v1/loans/{loanId}/deposit-collateral

Deposit additional collateral for a loan.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "100",
  "transactionHash": "tx456..."
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "totalCollateral": "600",
    "collateralRatio": "1.75"
  }
}
```

---

#### POST /api/v1/loans/{loanId}/release-collateral

Release excess collateral from a loan.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "amount": "50"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "releasedAmount": "50",
    "remainingCollateral": "550"
  }
}
```

---

### User Endpoints

#### GET /user/profile

Get the current user's profile (requires authentication).

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "publicKey": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "borrower",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

---

#### PATCH /user/profile

Update the current user's profile.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Request:**
```json
{
  "email": "newemail@example.com",
  "name": "Jane Doe"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile updated successfully"
}
```

---

### Pool Endpoints

#### GET /api/v1/pool/stats

Aggregate lending-pool statistics (total deposits, outstanding balance,
utilisation, APY, and the withdrawal cooldown).

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Scopes:** `read:pool`, lender role.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "totalDeposits": 100000,
    "totalOutstanding": 50000,
    "utilizationRate": 0.5,
    "apy": 0.08,
    "activeLoansCount": 42,
    "poolTokenAddress": "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "withdrawalCooldownLedgers": 0
  }
}
```

Amounts are derived from the database projection of contract events and are
reconciled against the contracts; see
[domain-state-machines.md](./domain-state-machines.md).

---

#### GET /api/v1/pool/{token}/share-price

Current share price of a pool token, read from the deployed contract and
cached briefly.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Scopes:** `read:pool`, lender role.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "sharePrice": 1050000,
    "sharePriceRatio": 1.05
  },
  "cached": false
}
```

**Notes:**
- `{token}` is the pool token contract identifier, not an internal pool id.
- A cache hit returns `"cached": true` with the previously computed value.

---

### Scoring Endpoints

#### POST /api/v1/score/calculate

Calculate a credit score for a borrower.

**Request:**
```json
{
  "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "score": 750,
    "grade": "A",
    "factors": {
      "repaymentHistory": 0.9,
      "loanCount": 0.8,
      "totalBorrowed": 0.75,
      "defaultRisk": 0.95
    },
    "calculatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

#### GET /api/v1/score/{borrower}

Get the most recent credit score for a borrower.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
    "score": 750,
    "grade": "A",
    "calculatedAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### Indexer Endpoints

#### GET /api/v1/indexer/events/borrower/{borrower}

Blockchain loan events (requests, approvals, repayments, defaults) for one
borrower. The authenticated wallet must be the borrower in the path.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Scopes:** `read:loans`.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "events": [
      {
        "type": "LoanRequested",
        "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
        "loanId": 123,
        "amount": "1000",
        "timestamp": "2024-01-01T12:00:00Z",
        "transactionHash": "tx123..."
      }
    ]
  },
  "page": {
    "next_cursor": null,
    "limit": 20
  }
}
```

**Notes:**
- `403` is returned when `{borrower}` is not the authenticated wallet.
- The list is a projection of indexed contract events and can lag the chain by
  up to one indexer poll interval.

---

#### GET /api/v1/indexer/events/loan/{loanId}

All indexed events for a specific loan. The authenticated wallet must be the
borrower of that loan.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "events": [
      {
        "type": "LoanRequested",
        "timestamp": "2024-01-01T12:00:00Z",
        "amount": "1000"
      },
      {
        "type": "LoanApproved",
        "timestamp": "2024-01-02T10:00:00Z"
      },
      {
        "type": "LoanRepaid",
        "timestamp": "2024-01-15T15:30:00Z",
        "amount": "1050"
      }
    ]
  }
}
```

**Notes:**
- Event types are mirrored from the contract events; see
  [domain-state-machines.md](./domain-state-machines.md#loan-lifecycle) for the
  authoritative lifecycle.

---

### Admin Endpoints

#### GET /api/v1/admin/loan-disputes

List loan disputes (admin only), newest first, using keyset pagination pinned to
a snapshot sequence so concurrent writes cannot cause duplicates or skips.

**Headers:**
```
x-api-key: <ADMIN_API_KEY>
```

**Scope:** `admin:disputes`.

**Query Parameters:**
```
?status=open&limit=20&cursor=<next_cursor>
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "loanId": 123,
        "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
        "status": "open",
        "reason": "amount_received_short",
        "createdAt": "2024-01-01T12:00:00Z"
      }
    ]
  },
  "page": {
    "next_cursor": null,
    "snapshot_seq": "42",
    "total_at_snapshot": 3,
    "limit": 20
  }
}
```

**Notes:**
- List loans for a borrower with `GET /api/v1/loans/borrower/{borrower}`;
  loan lifecycle states are documented in
  [domain-state-machines.md](./domain-state-machines.md).
- Pagination follows [pagination-contract.md](./pagination-contract.md).

---

#### POST /api/v1/admin/loans/{loanId}/approve

Approve a loan (admin only).

**Headers:**
```
x-api-key: <ADMIN_API_KEY>
Content-Type: application/json
Idempotency-Key: unique-key-value
```

**Request:**
```json
{
  "approverNotes": "Approved after verification"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "loanId": 123,
    "status": "approved",
    "approvedAt": "2024-01-02T10:00:00Z"
  }
}
```

---

#### POST /api/v1/admin/loans/{loanId}/reject

Reject a loan (admin only).

**Headers:**
```
x-api-key: <ADMIN_API_KEY>
Content-Type: application/json
```

**Request:**
```json
{
  "reason": "Insufficient collateral based on credit assessment"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Loan rejected successfully",
  "data": {
    "loanId": 123,
    "status": "rejected"
  }
}
```

---

### Remittances Endpoints

#### GET /api/v1/remittances

Get remittance records.

**Query Parameters:**
```
?borrower=G...&limit=10&offset=0
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "remittances": [
      {
        "remittanceId": "rem_123",
        "borrower": "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQONFUY4NOB4HST7R6C9DBWQLDA7",
        "amount": "500",
        "status": "completed",
        "createdAt": "2024-01-10T08:00:00Z",
        "completedAt": "2024-01-10T09:30:00Z"
      }
    ]
  }
}
```

---

### Notifications Endpoints

#### GET /api/v1/notifications

Get user notifications.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Query Parameters:**
```
?read=false&limit=20
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "notificationId": "notif_123",
        "type": "loan_approved",
        "message": "Your loan #123 has been approved",
        "read": false,
        "createdAt": "2024-01-02T10:00:00Z"
      }
    ]
  }
}
```

---

#### POST /api/v1/notifications/{notificationId}/read

Mark a notification as read.

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Notification marked as read"
}
```

---

### System Endpoints

#### GET /health

Health check endpoint (no authentication required).

**Response (200 OK):**
```json
{
  "status": "ok",
  "checks": {
    "api": "ok",
    "database": "ok",
    "redis": "ok",
    "soroban_rpc": "ok"
  },
  "uptime": 3600,
  "timestamp": 1700000000000
}
```

---

#### GET /health/deep

Deep health check (queries all dependencies).

**Response (200 OK):**
```json
{
  "status": "ok",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "stellarRpc": "ok",
    "indexer": {
      "status": "ok",
      "lagLedgers": 5
    }
  },
  "timestamp": 1700000000000
}
```

**Status Values:**
- `ok` — All services healthy
- `degraded` — Some services are slow or indexer is lagging
- `down` — Critical service is down

---

#### GET /version

Get deployment version and contract addresses.

**Response (200 OK):**
```json
{
  "gitSha": "abc123def456...",
  "builtAt": "2024-01-15T10:00:00Z",
  "nodeVersion": "v18.18.0",
  "contracts": {
    "loanManager": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    "lendingPool": "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4",
    "remittanceNft": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC4",
    "multisigGovernance": "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4"
  }
}
```

---

## Request Idempotency

For state-mutating operations (loans, payments, etc.), include an `Idempotency-Key` header to ensure safe retries:

```
Idempotency-Key: a-unique-uuid-v4-string
```

If the same key is sent within 24 hours, the server returns the cached response from the original request, preventing duplicate operations.

---

## Pagination

List endpoints support pagination via query parameters:

```
GET /api/v1/loans/borrower/{borrower}?limit=20&offset=0
```

**Response includes:**
- `total` — Total number of records
- `limit` — Number returned per page
- `offset` — Current offset from start
- `data` — Array of records

---

## Webhooks

Subscribe to events via webhooks for real-time notifications of loan approvals, repayments, and other state changes.

#### POST /api/indexer/webhooks/{id}/rotate-key
Stage a replacement signing key for an owned subscription. Requires
`Idempotency-Key`; the new secret is returned only once.

#### POST /api/indexer/webhooks/{id}/activate-key
Switch delivery signing to a staged key. The request body contains its `keyId`.

#### POST /api/indexer/webhooks/{id}/rollback-key
Retire a staged key before activation. The request body contains its `keyId`.

**Webhook Delivery Format:**
```json
{
  "type": "loan.approved",
  "data": {
    "loanId": 123,
    "borrower": "G...",
    "approvedAt": "2024-01-02T10:00:00Z"
  },
  "timestamp": 1704192000000
}
```

For detailed webhook configuration, see [docs/webhooks.md](./webhooks.md).

---

## Interactive API Documentation

An interactive Swagger UI is available at:

**Non-Production:** `https://api.remitlend.com/docs`

**Production (if enabled):** Set `ENABLE_SWAGGER=true` to expose at `/docs`

The raw OpenAPI 3.0 specification is available at `/docs.json`.

---

## Best Practices

### Security

- Always use HTTPS in production
- Store JWT tokens securely (localStorage or secure cookies)
- Rotate API keys regularly
- Never commit API keys to version control
- Validate all input before sending to the API

### Error Handling

- Implement exponential backoff for retries
- Check response status codes and `success` field
- Use `Idempotency-Key` headers for safety
- Log error messages for debugging

### Performance

- Implement pagination for list endpoints
- Cache responses where appropriate
- Avoid polling; use webhooks for real-time updates
- Use connection pooling if possible

### Monitoring

- Monitor rate limit headers (`X-RateLimit-*`)
- Track response times and error rates
- Set up alerts for 5xx errors
- Use correlation IDs (`x-request-id`) and W3C Trace Context (`traceparent`)
  for request tracing. Send a `traceparent` header to continue your own trace;
  the API echoes its child span back in the response `traceparent` header. See
  [domain-state-machines.md](./domain-state-machines.md#observability-trace-context).

---

## Support and Feedback

For issues, questions, or feature requests:

- **GitHub Issues:** [remitlend/issues](https://github.com/JhayJ22/remitlend/issues)
- **Documentation:** [GitHub Docs](https://github.com/JhayJ22/remitlend/tree/main/docs)
- **Security Issues:** Please report privately to maintainers

---

**Last Updated:** 2024-01-15  
**API Version:** 1.0.0  
**Status:** Production

---

## Executable Verification (clean checkout)

This reference is machine-checked, so a clean checkout cannot drift from the
implementation without failing CI. Every endpoint documented here is asserted
against the OpenAPI spec that `/docs.json` serves at runtime — parsed directly
from the route handlers via `swagger-jsdoc`.

```bash
# from the repository root, on a clean checkout
cd backend
npm ci
npm run docs:check      # or: npm test -- apiReference
```

What the check verifies:

| Assertion | Why it matters |
| --- | --- |
| Every `#### METHOD /path` heading in this file resolves to a live Express route with that exact method (mount prefixes and `{param}` syntax normalised). | A documented endpoint that no longer exists misleads integrators. |
| Every documented section carries a `**Request**` or `**Response**` block. | Catches headings added without content. |
| The live route table is enumerated from the running application and is at least as large as the documented set. | Catches a parsing regression that would make the check vacuously pass. |
| `/api/`-prefixed paths match a real mount prefix. | Catches a base-path rename that would 404 for every consumer. |

Contributor workflow when adding an endpoint: implement the route (with its
`@openapi` JSDoc block if it should appear in Swagger), add the
`#### METHOD /path` section here with a request and a response example, then run
`npm run docs:check` (or `npm test -- apiReference`) from `backend/`.

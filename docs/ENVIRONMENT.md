# Environment Variable Reference

This document lists every environment variable used by the RemitLend platform. Each table covers one package.

---

## Demo Mode

RemitLend includes a **demo / sandbox mode** that lets frontend developers and
integration testers exercise API routes without interacting with real contracts
or payment rails.  When enabled, certain endpoints return mock data instead of
calling on-chain logic.

### Enabling Demo Mode

Set the following environment variable in the backend:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_MODE` | (unset) | Set to `"true"` to enable sandbox responses for demo-gated routes |

### Scope

The files `backend/src/utils/demo.ts` and `backend/src/utils/demo-rate-limit.ts`
are standalone demonstration scripts that illustrate how limit capping and rate
limiting work.  They are not middleware themselves, but they document the
patterns used by the sandbox middleware that activates when `DEMO_MODE=true`.

Routes that check `DEMO_MODE` respond with mock data and are subject to a
stricter rate limit (10 requests/minute/IP) to prevent abuse.

---

## Backend (`backend/`)

| Variable | Dev | Staging | Prod | Default | Description | Source |
|---|---|---|---|---|---|---|
| `LOG_LEVEL` | — | — | — | `debug` (dev) / `info` (other envs) | Winston log level override (`error`, `warn`, `info`, `http`, `debug`). Falls back to the `NODE_ENV` default when unset or invalid. | `backend/src/utils/logger.ts` |
| `TRACE_CONTEXT_SAMPLE_RATE` | — | — | — | `1` | Fraction of *root* traces (requests arriving without a `traceparent`) that are marked sampled. Values outside `[0, 1]` fall back to `1`. Inheriting a caller's sampled flag is unaffected. | `backend/src/utils/traceContext.ts` |
| `CORS_ALLOWED_ORIGINS` | ✓ | ✓ | ✓ | `http://localhost:3000,http://localhost:3001` | Comma-separated origins allowed by CORS | `backend/src/config/index.ts` |
| `FRONTEND_URL` | ✓ | ✓ | ✓ | `http://localhost:3000` | Frontend base URL used for links | `backend/src/config/index.ts` |
| `PORT` | ✓ | ✓ | ✓ | `3001` | HTTP port the API listens on | `backend/src/index.ts` |
| `DATABASE_URL` | ✓ | ✓ | ✓ | `postgres://postgres:postgres@db:5432/remitlend` | PostgreSQL connection string | `backend/src/db/connection.js` |
| `DB_CONN_TIMEOUT_MS` | — | ✓ | ✓ | `10000` | Pool connection timeout in ms; pool.connect() rejects instead of hanging | `backend/src/db/connection.ts` |
| `DB_STATEMENT_TIMEOUT_MS` | — | ✓ | ✓ | `30000` | Per-query statement_timeout in ms; a stuck query never holds a connection indefinitely | `backend/src/db/connection.ts` |
| `REDIS_URL` | ✓ | ✓ | ✓ | `redis://redis:6379` | Redis connection string | `backend/src/services/cacheService.ts` |
| `STELLAR_NETWORK` | ✓ | ✓ | ✓ | `testnet` | Stellar network name (`testnet`, `mainnet`) | `backend/src/config/stellar.ts` |
| `STELLAR_RPC_URL` | ✓ | ✓ | ✓ | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint | `backend/src/config/stellar.ts` |
| `SOROBAN_REQUIRE_RPC_AT_STARTUP` | ✓ | ✓ | ✓ | `false` | When `"true"`, startup fails if the Soroban RPC is unreachable. Default is to boot in degraded mode: reads serve last-known data and writes are queued. | `backend/src/services/sorobanService.ts` |
| `SOROBAN_RPC_HEALTH_TIMEOUT_MS` | ✓ | ✓ | ✓ | `1500` | Timeout for a single Soroban RPC health probe in ms | `backend/src/services/sorobanCircuitBreaker.ts` |
| `SOROBAN_RPC_HEALTH_CACHE_MS` | ✓ | ✓ | ✓ | `3000` | How long an RPC health-probe result is reused before probing again, in ms | `backend/src/services/sorobanCircuitBreaker.ts` |
| `SOROBAN_CIRCUIT_FAILURE_THRESHOLD` | ✓ | ✓ | ✓ | `3` | Consecutive RPC failures that open the degradation circuit | `backend/src/services/sorobanCircuitBreaker.ts` |
| `SOROBAN_CIRCUIT_COOLDOWN_MS` | ✓ | ✓ | ✓ | `15000` | How long the circuit stays open before a single half-open recovery attempt, in ms | `backend/src/services/sorobanCircuitBreaker.ts` |
| `SOROBAN_STALE_READ_TTL_MS` | ✓ | ✓ | ✓ | `3600000` | How long a last known-good read value stays usable while the RPC is down, in ms | `backend/src/services/sorobanCircuitBreaker.ts` |
| `SOROBAN_STALE_WARNING_TTL_MS` | ✓ | ✓ | ✓ | `60000` | How long read responses keep advertising the `degraded: true` warning after stale data was served, in ms | `backend/src/services/sorobanCircuitBreaker.ts` |
| `SOROBAN_WRITE_REPLAY_INTERVAL_MS` | ✓ | ✓ | ✓ | `15000` | How often the replay worker drains the queued-write table, in ms | `backend/src/services/sorobanWriteReplayProcessor.ts` |
| `SOROBAN_WRITE_REPLAY_BATCH_SIZE` | ✓ | ✓ | ✓ | `25` | Maximum queued writes replayed per pass | `backend/src/services/sorobanWriteReplayProcessor.ts` |
| `SOROBAN_WRITE_BACKOFF_BASE_MS` | ✓ | ✓ | ✓ | `5000` | Base delay before retrying a queued write that failed to replay, in ms | `backend/src/services/sorobanWriteQueue.ts` |
| `SOROBAN_WRITE_BACKOFF_MAX_MS` | ✓ | ✓ | ✓ | `300000` | Ceiling for the queued-write replay backoff, in ms | `backend/src/services/sorobanWriteQueue.ts` |
| `STELLAR_NETWORK_PASSPHRASE` | ✓ | ✓ | ✓ | `Test SDF Network ; September 2015` | Network passphrase for transaction signing | `backend/src/config/stellar.ts` |
| `LOAN_MANAGER_CONTRACT_ID` | ✓ | ✓ | ✓ | — | Deployed loan manager contract address | `backend/src/config/stellar.ts` |
| `REMITTANCE_NFT_CONTRACT_ID` | ✓ | ✓ | ✓ | — | Deployed remittance NFT contract address | `backend/src/config/contracts.ts` |
| `LENDING_POOL_CONTRACT_ID` | ✓ | ✓ | ✓ | — | Deployed lending pool contract address | `backend/src/config/stellar.ts` |
| `MULTISIG_GOVERNANCE_CONTRACT_ID` | ✓ | ✓ | ✓ | — | Deployed multisig governance contract address | `backend/src/config/contracts.ts` |
| `POOL_TOKEN_ADDRESS` | ✓ | ✓ | ✓ | — | Pool token contract address | `backend/src/config/stellar.ts` |
| `STELLAR_USDC_ISSUER` | — | ✓ | ✓ | — | USDC asset issuer address | `backend/src/config/stellar.ts` |
| `STELLAR_EURC_ISSUER` | — | ✓ | ✓ | — | EURC asset issuer address | `backend/src/config/stellar.ts` |
| `STELLAR_PHP_ISSUER` | — | ✓ | ✓ | — | PHP asset issuer address | `backend/src/config/stellar.ts` |
| `LOAN_MANAGER_ADMIN_SECRET` | ✓ | ✓ | ✓ | — | Admin secret key for loan manager operations | `backend/src/config/stellar.ts` |
| `SCORE_RECONCILIATION_SOURCE_SECRET` | — | ✓ | ✓ | — | Secret key for score reconciliation operations | `backend/src/services/scoreService.ts` |
| `LOAN_MIN_SCORE` | ✓ | ✓ | ✓ | `500` | Minimum credit score to request a loan | `backend/src/config/loans.ts` |
| `LOAN_MAX_AMOUNT` | ✓ | ✓ | ✓ | `50000` | Maximum loan amount in USD | `backend/src/config/loans.ts` |
| `LOAN_INTEREST_RATE_PERCENT` | ✓ | ✓ | ✓ | `12` | Annual interest rate percentage | `backend/src/config/loans.ts` |
| `CREDIT_SCORE_THRESHOLD` | ✓ | ✓ | ✓ | `600` | Threshold for loan approval score | `backend/src/config/loans.ts` |
| `SCORE_DELTA_REPAY` | ✓ | ✓ | ✓ | `15` | Points added to score on timely repayment | `backend/src/config/scores.ts` |
| `SCORE_DELTA_DEFAULT` | ✓ | ✓ | ✓ | `50` | Points deducted on default | `backend/src/config/scores.ts` |
| `SCORE_DELTA_LATE` | ✓ | ✓ | ✓ | `5` | Points deducted on late payment | `backend/src/config/scores.ts` |
| `INDEXER_POLL_INTERVAL_MS` | ✓ | ✓ | ✓ | `30000` | Event indexer poll interval in milliseconds | `backend/src/config/indexer.ts` |
| `INDEXER_BATCH_SIZE` | ✓ | ✓ | ✓ | `100` | Events fetched per poll cycle | `backend/src/config/indexer.ts` |
| `INDEXER_HEALTH_LAG_LIMIT` | ✓ | ✓ | ✓ | `100` | Maximum ledger lag before `/health/deep` reports the indexer as degraded | `backend/src/services/healthService.ts` |
| `DEFAULT_CHECK_INTERVAL_MS` | ✓ | ✓ | ✓ | `1800000` | Default checker interval (30 min) | `backend/src/services/defaultChecker.ts` |
| `DEFAULT_CHECK_MAX_LOANS_PER_RUN` | ✓ | ✓ | ✓ | `500` | Max loans processed per default check run | `backend/src/services/defaultChecker.ts` |
| `DEFAULT_CHECK_BATCH_SIZE` | ✓ | ✓ | ✓ | `25` | Loans per batch during default check | `backend/src/services/defaultChecker.ts` |
| `DEFAULT_CHECK_BATCH_TIMEOUT_MS` | ✓ | ✓ | ✓ | `300000` | Timeout per batch (5 min) | `backend/src/services/defaultChecker.ts` |
| `DEFAULT_CHECK_CONCURRENCY` | ✓ | ✓ | ✓ | `3` | Concurrent check workers | `backend/src/services/defaultChecker.ts` |
| `DEFAULT_CHECK_POLL_ATTEMPTS` | ✓ | ✓ | ✓ | `30` | Max poll attempts per check | `backend/src/services/defaultChecker.ts` |
| `DEFAULT_CHECK_POLL_SLEEP_MS` | ✓ | ✓ | ✓ | `1000` | Sleep between poll attempts | `backend/src/services/defaultChecker.ts` |
| `LOAN_TERM_LEDGERS` | ✓ | ✓ | ✓ | `17280` | Default loan term in ledgers (~30 days) | `backend/src/config/loans.ts` |
| `SCORE_RECONCILIATION_INTERVAL_MS` | ✓ | ✓ | ✓ | `3600000` | Score reconciliation interval | `backend/src/config/scores.ts` |
| `SCORE_RECONCILIATION_MAX_BORROWERS_PER_RUN` | ✓ | ✓ | ✓ | `500` | Max borrowers per reconciliation run | `backend/src/config/scores.ts` |
| `SCORE_RECONCILIATION_BATCH_SIZE` | ✓ | ✓ | ✓ | `25` | Borrowers per batch in reconciliation | `backend/src/config/scores.ts` |
| `SCORE_RECONCILIATION_AUTOCORRECT_ENABLED` | ✓ | ✓ | ✓ | `false` | Enable automatic score correction | `backend/src/config/scores.ts` |
| `SCORE_RECONCILIATION_AUTOCORRECT_THRESHOLD` | ✓ | ✓ | ✓ | `50` | Max points auto-corrected per run | `backend/src/config/scores.ts` |
| `JWT_SECRET` | ✓ | ✓ | ✓ | `your-super-secret-jwt-key-change-in-production` | JWT signing/verification secret | `backend/src/middleware/jwtAuth.ts` |
| `INTERNAL_API_KEY` | ✓ | ✓ | ✓ | `change-me` | API key for internal endpoints | `backend/src/middleware/auth.ts` |
| `ADMIN_WALLETS` | ✓ | ✓ | ✓ | — | Comma-separated Stellar public keys granted the `admin` role (`admin:all` scope). **Security-critical**: any wallet listed here receives full admin privileges. Unlisted wallets default to `borrower`. | `backend/src/auth/rbac.ts` |
| `LENDER_WALLETS` | ✓ | ✓ | ✓ | — | Comma-separated Stellar public keys granted the `lender` role (`read:loans`, `read:pool` scopes). Unlisted wallets default to `borrower`. | `backend/src/auth/rbac.ts` |
| `EXPOSE_STACK_TRACES` | — | — | — | `false` | When `"true"`, include stack traces in error responses. **Never enable in production.** | `backend/src/middleware/errorHandler.ts` |
| `JWT_COOKIE_NAME` | ✓ | ✓ | ✓ | `remitlend_jwt` | Name of the HTTP cookie used to transport the JWT token | `backend/src/middleware/jwtAuth.ts` |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | ✓ | ✓ | ✓ | `30000` | Outgoing webhook request timeout | `backend/src/services/webhookService.ts` |
| `SENTRY_DSN` | — | ✓ | ✓ | — | Sentry DSN for backend error tracking | `backend/src/app.ts` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ✓ | ✓ | ✓ | — | Base URL of an OTLP/HTTP collector (Jaeger, Tempo, OTel Collector). Unset disables trace export. Spans are exported through Sentry's OpenTelemetry provider. | `backend/src/config/tracing.ts` |
| `OTEL_SERVICE_NAME` | ✓ | ✓ | ✓ | — | `service.name` reported on exported spans | `backend/src/config/tracing.ts` |
| `OTEL_TRACES_SAMPLE_RATE` | ✓ | ✓ | ✓ | `0.2` (prod) / `1` (other) | Fraction of traces sampled (0..1); invalid values fall back to the default | `backend/src/config/tracing.ts` |
| `NOTIFICATION_RETENTION_DAYS` | ✓ | ✓ | ✓ | `90` | Legacy setting; scheduled retention uses the approved 90-day matrix policy | `backend/src/config/envSchema.ts` |
| `READ_NOTIFICATION_RETENTION_DAYS` | ✓ | ✓ | ✓ | `30` | Legacy setting; scheduled retention uses the approved 90-day matrix policy for all notifications | `backend/src/config/envSchema.ts` |
| `SENDGRID_API_KEY` | — | ✓ | ✓ | — | SendGrid API key for email | `backend/src/services/emailService.ts` |
| `FROM_EMAIL` | — | ✓ | ✓ | — | Sender email address | `backend/src/services/emailService.ts` |
| `ADMIN_EMAIL` | — | ✓ | ✓ | — | Admin notification email | `backend/src/services/notificationService.ts` |
| `ADMIN_WEBHOOK_URL` | — | ✓ | ✓ | — | Admin notification webhook URL | `backend/src/services/notificationService.ts` |
| `TWILIO_ACCOUNT_SID` | — | ✓ | ✓ | — | Twilio account SID for SMS | `backend/src/services/smsService.ts` |
| `TWILIO_AUTH_TOKEN` | — | ✓ | ✓ | — | Twilio auth token | `backend/src/services/smsService.ts` |
| `TWILIO_PHONE_NUMBER` | — | ✓ | ✓ | — | Twilio sender phone number | `backend/src/services/smsService.ts` |
| `PII_KEK_ID` | ✓ | ✓ | ✓ | `default-kek` | Key Encryption Key (KEK) ID in KMS. Used to wrap/unwrap Data Encryption Keys (DEKs) for PII field encryption. When rotating keys, update this to the new KEK ID. | `backend/src/services/piiCrypto.ts`, `backend/src/services/keyRotationService.ts` |
| `PII_KEK_KEY` | ✓ | ✓ | ✓ | `0` (32 zeros) | Local KEK key (hex-encoded 256-bit) when `PII_KMS_ENDPOINT` is not set. In production, use an external KMS. | `backend/src/services/piiCrypto.ts` |
| `PII_KMS_ENDPOINT` | — | ✓ | ✓ | — | HTTP endpoint for KMS key wrapping/unwrapping operations (e.g., `https://kms.example.com`). When set, the service uses this endpoint; otherwise, local encryption using `PII_KEK_KEY` is used. Must be HTTPS in production. | `backend/src/services/piiCrypto.ts`, `backend/src/services/keyRotationService.ts` |
| `PII_KMS_REGION` | — | ✓ | ✓ | — | AWS region for KMS endpoint (used only if `PII_KMS_ENDPOINT` points to AWS KMS). | `backend/src/services/piiCrypto.ts` |

---

## Frontend (`frontend/`)

| Variable                           | Dev | Staging | Prod | Default                                   | Description                                            | Source                                      |
| ---------------------------------- | --- | ------- | ---- | ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `NEXT_PUBLIC_API_URL`              | ✓   | ✓       | ✓    | `http://localhost:3001`                   | Backend API base URL                                   | `frontend/src/app/hooks/useApi.ts`          |
| `NEXT_PUBLIC_APP_URL`              | ✓   | ✓       | ✓    | `https://remitlend.com`                   | Public-facing app URL used for absolute links          | `frontend/src/lib/canonicalUrl.ts`          |
| `NEXT_PUBLIC_SENTRY_DSN`           | —   | ✓       | ✓    | —                                         | Sentry DSN for frontend error tracking                 | `frontend/src/sentry.client.config.ts`      |
| `SENTRY_DSN`                       | —   | ✓       | ✓    | —                                         | Sentry DSN server-side                                 | `frontend/src/sentry.server.config.ts`      |
| `SENTRY_ORG`                       | —   | ✓       | ✓    | —                                         | Sentry organization slug                               | `frontend/sentry.client.config.ts`          |
| `SENTRY_PROJECT`                   | —   | ✓       | ✓    | —                                         | Sentry project slug                                    | `frontend/sentry.client.config.ts`          |
| `SENTRY_AUTH_TOKEN`                | —   | ✓       | ✓    | —                                         | Sentry auth token for source maps                      | `frontend/next.config.ts`                   |
| `NODE_ENV`                         | ✓   | ✓       | ✓    | `development`                             | Node environment (`development`, `test`, `production`) | `next.config.ts`                            |
| `NEXT_PUBLIC_STELLAR_RPC_URL`       | ✓   | ✓       | ✓    | `https://soroban-testnet.stellar.org`     | Soroban RPC endpoint for simulating and submitting contract calls | `frontend/.env.example` |
| `NEXT_PUBLIC_HORIZON_URL`           | ✓   | ✓       | ✓    | `https://horizon-testnet.stellar.org`     | Horizon endpoint for resolving transaction error details        | `frontend/.env.example` |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | ✓ | ✓ | ✓ | `Test SDF Network ; September 2015` | Network passphrase the wallet signs against                    | `frontend/.env.example` |
| `NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID` | ✓ | ✓ | ✓ | —                                        | Lending pool manager contract address (frontend mirror of the backend's `LENDING_POOL_CONTRACT_ID`). Canonical name — the legacy `NEXT_PUBLIC_MANAGER_CONTRACT_ID` is still read as a fallback. | `frontend/.env.example` |
| `NEXT_PUBLIC_LOAN_MANAGER_CONTRACT_ID` | ✓ | ✓ | ✓ | —                                        | Loan manager contract address                                   | `frontend/.env.example` |
| `NEXT_PUBLIC_NFT_CONTRACT_ID`       | ✓   | ✓       | ✓    | —                                        | Remittance NFT contract address                                 | `frontend/.env.example` |
| `NEXT_PUBLIC_STELLAR_EXPLORER_URL` | ✓   | ✓       | ✓    | `https://stellar.expert/explorer/testnet` | Stellar explorer base URL for transaction links        | `frontend/src/components/ui/TxHashLink.tsx` |
| `NEXT_PUBLIC_CONTRACT_VERSION` | ✓ | ✓ | ✓ | `v1` | Contract ABI version the frontend targets (`v1` or `v2`). Unrecognised values fall back to `v1`. The flag only selects which Soroban function name is called, never which numbers are displayed; rollback is a one-env-var change plus rebuild. See `frontend/src/app/utils/contractVersion.ts`. | `frontend/.env.example` |
| `NEXT_PUBLIC_SERVICE_HEALTH_POLL_MS` | ✓ | ✓ | ✓ | `30000` | How often `ServiceStatusProvider` polls `/health` and `/status/pause` to drive the degraded-service banner. Set to `0` to disable polling entirely. | `frontend/.env.example` |

---

## Contracts / Scripts (`contracts/`, `scripts/`)

| Variable                     | Dev | Staging | Prod | Default                               | Description                                | Source              |
| ---------------------------- | --- | ------- | ---- | ------------------------------------- | ------------------------------------------ | ------------------- |
| `SOROBAN_RPC_URL`            | ✓   | ✓       | ✓    | `https://soroban-testnet.stellar.org` | RPC URL for contract deployment            | `scripts/deploy.ts` |
| `SOROBAN_NETWORK_PASSPHRASE` | ✓   | ✓       | ✓    | `Test SDF Network ; September 2015`   | Network passphrase for contract operations | `scripts/deploy.ts` |
| `SOROBAN_ACCOUNT`            | ✓   | ✓       | ✓    | —                                     | Deployer account secret key                | `scripts/deploy.ts` |
| `DEPLOY_CONFIG_PATH`         | —   | ✓       | ✓    | `scripts/deploy-config.json`          | Path to deploy configuration               | `scripts/deploy.ts` |

---

## Docker Compose Production

The production Compose deployment uses the following variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `OWNER` | Yes | — | GitHub Container Registry owner/organization used to pull RemitLend production images |
| `TAG` | Yes | — | Production image tag. Use an explicit release tag; do not use `latest` or a staging tag |
| `POSTGRES_DB` | Yes | — | PostgreSQL database name 
|
| `POSTGRES_USER` | Yes | — | PostgreSQL database user |


### Production Secrets

The PostgreSQL password is provided through the Docker Compose secrets mechanism rather than an environment variable.

Create the secret on the deployment host:

```bash
mkdir -p secrets
openssl rand -base64 48 > secrets/postgres_password.txt
chmod 600 secrets/postgres_password.txt

## Pinned Infrastructure Image Versions

The `docker-compose.yml` and `docker-compose.staging.yml` files pin dependency
images to specific minor versions to prevent silent environment drift.

| Service  | Image                  | Used in |
| -------- | ---------------------- | ------- |
| Postgres | `postgres:16.9-alpine` | `docker-compose.yml`, `docker-compose.staging.yml`, `docker-compose.production.yml` |
| Redis    | `redis:7.4-alpine`     | `docker-compose.yml`, `docker-compose.staging.yml`, `docker-compose.production.yml` |

When upgrading either dependency, update **all** compose files and this table
in the same PR.

---

## `.env.example` vs `ENVIRONMENT.md` Drift

A CI job (`env-docs-check`) runs on every PR to ensure the keys listed in `.env.example` files are present in this document. The check performs a sorted diff and fails if any key is missing from either side.

To update this document after adding a new environment variable:

1. Add the variable to the relevant `.env.example` file.
2. Add a row to the table above with all columns filled.
3. The CI job will pass automatically.

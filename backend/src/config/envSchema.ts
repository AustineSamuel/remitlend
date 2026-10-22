import { z } from 'zod';
import logger from '../utils/logger.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce a string env var to a positive integer within [min, max]. */
const positiveInt = (min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .trim()
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().min(min).max(max));

/** Non-empty string after trimming. */
const requiredString = () => z.string().trim().min(1);

/** Optional string — coerce absent/empty to undefined. */
const optionalString = () => z.string().trim().optional();

/** Boolean-like env var: "true" | "false". */
const booleanString = () =>
  z.enum(['true', 'false']).transform((v) => v === 'true');

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * Full schema for all recognised backend environment variables.
 *
 * Required variables cause an immediate process.exit(1) when absent or empty.
 * Optional variables with a `.default()` clause never throw; they fall back
 * to the documented default.
 *
 * See docs/ENVIRONMENT.md for the authoritative reference.
 */
export const envSchema = z.object({
  // ── Server ──────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),

  PORT: positiveInt(1, 65535).default(3001 as unknown as never),

  CORS_ALLOWED_ORIGINS: requiredString(),
  FRONTEND_URL: requiredString().url(),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: requiredString().url(),

  DB_CONN_TIMEOUT_MS: positiveInt(100).default(10000 as unknown as never),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(100).default(30000 as unknown as never),

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_URL: requiredString().url(),

  // ── Authentication ────────────────────────────────────────────────────────
  JWT_SECRET: requiredString().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_COOKIE_NAME: requiredString().default('remitlend_jwt'),

  INTERNAL_API_KEY: requiredString(),

  // ── Stellar ──────────────────────────────────────────────────────────────
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  STELLAR_RPC_URL: requiredString().url(),
  STELLAR_NETWORK_PASSPHRASE: requiredString(),

  LOAN_MANAGER_CONTRACT_ID: requiredString(),
  LENDING_POOL_CONTRACT_ID: requiredString(),
  REMITTANCE_NFT_CONTRACT_ID: requiredString(),
  MULTISIG_GOVERNANCE_CONTRACT_ID: requiredString(),
  POOL_TOKEN_ADDRESS: requiredString(),

  LOAN_MANAGER_ADMIN_SECRET: requiredString(),
  SCORE_RECONCILIATION_SOURCE_SECRET: optionalString(),

  STELLAR_USDC_ISSUER: optionalString(),
  STELLAR_EURC_ISSUER: optionalString(),
  STELLAR_PHP_ISSUER: optionalString(),

  // ── Loan configuration ────────────────────────────────────────────────────
  LOAN_MIN_SCORE: positiveInt(300, 850),
  LOAN_MAX_AMOUNT: positiveInt(1, 1_000_000),
  LOAN_INTEREST_RATE_PERCENT: positiveInt(1, 100),
  CREDIT_SCORE_THRESHOLD: positiveInt(300, 850),

  // ── Score deltas ──────────────────────────────────────────────────────────
  SCORE_DELTA_REPAY: positiveInt(1, 200),
  SCORE_DELTA_DEFAULT: positiveInt(1, 200),
  SCORE_DELTA_LATE: positiveInt(1, 200),

  // ── Indexer ───────────────────────────────────────────────────────────────
  INDEXER_POLL_INTERVAL_MS: positiveInt(1000).default(30000 as unknown as never),
  INDEXER_BATCH_SIZE: positiveInt(1, 10000).default(100 as unknown as never),
  INDEXER_HEALTH_LAG_LIMIT: positiveInt(1).default(100 as unknown as never),

  // ── Indexer — adaptive scheduler ──────────────────────────────────────────
  /** Enable the adaptive scheduler; set to "false" to use fixed polling. */
  INDEXER_ADAPTIVE_SCHEDULING: booleanString().default('true' as unknown as never),

  /**
   * Ledger-lag threshold below which the indexer is considered "caught up".
   * When lag ≤ this value the slow, steady-state poll interval is used.
   */
  INDEXER_CAUGHT_UP_THRESHOLD: positiveInt(1).default(50 as unknown as never),

  /**
   * Ledger-lag threshold above which the indexer is considered aggressively
   * behind and switches to the fastest catch-up interval and batch size.
   */
  INDEXER_AGGRESSIVE_THRESHOLD: positiveInt(1).default(100 as unknown as never),

  /** Poll interval (ms) when the indexer is caught up (lag ≤ CAUGHT_UP_THRESHOLD). */
  INDEXER_INTERVAL_CAUGHT_UP_MS: positiveInt(1000).default(30000 as unknown as never),

  /** Poll interval (ms) when the indexer is moderately behind. */
  INDEXER_INTERVAL_BEHIND_MS: positiveInt(1000).default(10000 as unknown as never),

  /** Poll interval (ms) when the indexer is aggressively catching up. */
  INDEXER_INTERVAL_CATCH_UP_MS: positiveInt(100).default(3000 as unknown as never),

  /** Batch size when the indexer is caught up. */
  INDEXER_BATCH_SIZE_CAUGHT_UP: positiveInt(1, 10000).default(100 as unknown as never),

  /** Batch size when the indexer is moderately behind. */
  INDEXER_BATCH_SIZE_BEHIND: positiveInt(1, 10000).default(200 as unknown as never),

  /** Batch size when the indexer is aggressively catching up. */
  INDEXER_BATCH_SIZE_CATCH_UP: positiveInt(1, 10000).default(500 as unknown as never),

  /** Base delay (ms) for exponential back-off on repeated indexer errors. */
  INDEXER_BACKOFF_BASE_MS: positiveInt(100).default(5000 as unknown as never),

  /** Maximum delay (ms) cap for exponential back-off on repeated indexer errors. */
  INDEXER_BACKOFF_MAX_MS: positiveInt(1000).default(135000 as unknown as never),

  // ── Default checker ───────────────────────────────────────────────────────
  DEFAULT_CHECK_INTERVAL_MS: positiveInt(1000).default(1800000 as unknown as never),
  DEFAULT_CHECK_MAX_LOANS_PER_RUN: positiveInt(1).default(500 as unknown as never),
  DEFAULT_CHECK_BATCH_SIZE: positiveInt(1, 1000).default(25 as unknown as never),
  DEFAULT_CHECK_BATCH_TIMEOUT_MS: positiveInt(1000).default(300000 as unknown as never),
  DEFAULT_CHECK_CONCURRENCY: positiveInt(1, 50).default(3 as unknown as never),
  DEFAULT_CHECK_POLL_ATTEMPTS: positiveInt(1).default(30 as unknown as never),
  DEFAULT_CHECK_POLL_SLEEP_MS: positiveInt(100).default(1000 as unknown as never),
  LOAN_TERM_LEDGERS: positiveInt(1).default(17280 as unknown as never),

  // ── Score reconciliation ──────────────────────────────────────────────────
  SCORE_RECONCILIATION_INTERVAL_MS: positiveInt(1000).default(3600000 as unknown as never),
  SCORE_RECONCILIATION_MAX_BORROWERS_PER_RUN: positiveInt(1).default(500 as unknown as never),
  SCORE_RECONCILIATION_BATCH_SIZE: positiveInt(1, 1000).default(25 as unknown as never),
  SCORE_RECONCILIATION_AUTOCORRECT_ENABLED: booleanString().default(
    'false' as unknown as never,
  ),
  SCORE_RECONCILIATION_AUTOCORRECT_THRESHOLD: positiveInt(1).default(50 as unknown as never),

  // ── RBAC ──────────────────────────────────────────────────────────────────
  ADMIN_WALLETS: optionalString().default(''),
  LENDER_WALLETS: optionalString().default(''),

  // ── Webhooks ──────────────────────────────────────────────────────────────
  WEBHOOK_REQUEST_TIMEOUT_MS: positiveInt(1000).default(30000 as unknown as never),

  // ── Notifications ─────────────────────────────────────────────────────────
  NOTIFICATION_RETENTION_DAYS: positiveInt(1, 3650).default(90 as unknown as never),
  READ_NOTIFICATION_RETENTION_DAYS: positiveInt(1, 3650).default(30 as unknown as never),

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'debug'])
    .default('info'),

  // ── Debugging ────────────────────────────────────────────────────────────
  EXPOSE_STACK_TRACES: booleanString().default('false' as unknown as never),

  // ── Diagnostic bundles ───────────────────────────────────────────────────
  /**
   * How long (in hours) a generated transaction diagnostic bundle remains
   * downloadable before it expires and is purged. Bundles are intentionally
   * short-lived; keep this small (default 24h, max 168h = 7 days).
   */
  DIAGNOSTIC_BUNDLE_TTL_HOURS: positiveInt(1, 168).default(24 as unknown as never),

  /**
   * Hard upper bound (in bytes) on the serialized diagnostic bundle. The
   * bundle generator refuses to emit anything larger, keeping artifacts
   * bounded and safe to attach to support tickets.
   */
  DIAGNOSTIC_BUNDLE_MAX_BYTES: positiveInt(1).default(65536 as unknown as never),

  // ── External services (optional) ─────────────────────────────────────────
  SENTRY_DSN: optionalString(),

  SENDGRID_API_KEY: optionalString(),
  FROM_EMAIL: optionalString(),

  ADMIN_EMAIL: optionalString(),
  ADMIN_WEBHOOK_URL: optionalString(),

  TWILIO_ACCOUNT_SID: optionalString(),
  TWILIO_AUTH_TOKEN: optionalString(),
  TWILIO_PHONE_NUMBER: optionalString(),
});

// ── Inferred type ─────────────────────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

// ── Parsed singleton (populated by validateEnvSchema) ────────────────────────

let _env: Env | undefined;

/**
 * Returns the validated, typed environment configuration.
 *
 * Throws if called before `validateEnvSchema()` has been invoked.
 */
export function getEnv(): Env {
  if (!_env) {
    throw new Error(
      'getEnv() called before validateEnvSchema(). ' +
        'Make sure validateEnvSchema() is the first call in src/index.ts.',
    );
  }
  return _env;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates all environment variables against the Zod schema.
 *
 * On success  → stores the parsed result internally and logs a confirmation.
 * On failure  → logs each validation error with a human-readable message and
 *               terminates the process with exit code 1 so the container
 *               never starts with a misconfigured environment.
 *
 * This supersedes the old string-list check in env.ts and should be the
 * single point of env validation called at startup (see src/index.ts).
 */
export function validateEnvSchema(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const boldRed = (msg: string) => `\x1b[1;31m${msg}\x1b[0m`;
    const bold = (msg: string) => `\x1b[1m${msg}\x1b[0m`;

    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `  • ${bold(path)}: ${issue.message}`;
    });

    const errorPrefix = boldRed('FATAL ERROR: Environment schema validation failed');
    const actionMsg =
      'Please verify the variables listed above in your \x1b[4m.env\x1b[0m file or deployment environment.';

    console.error(`\n${errorPrefix}\n${issues.join('\n')}\n${actionMsg}\n`);

    logger.error('Environment schema validation failure', {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
      node_env: process.env.NODE_ENV,
    });

    process.exit(1);
  }

  _env = result.data;

  logger.info('Environment schema validated successfully.', {
    node_env: _env.NODE_ENV,
    stellar_network: _env.STELLAR_NETWORK,
  });

  return _env;
}

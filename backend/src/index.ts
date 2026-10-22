import dotenv from 'dotenv';
dotenv.config();

import { validateEnvVars } from './config/env.js';
validateEnvVars();

// Sentry must be initialized before any other imports so it can instrument them
import { initSentry } from './config/sentry.js';
initSentry();

const app = (await import('./app.js')).default;
import logger from './utils/logger.js';
import { closePool } from './db/connection.js';
import { startIndexer, stopIndexer } from './services/indexerManager.js';
import {
  startDefaultCheckerScheduler,
  stopDefaultCheckerScheduler,
} from './services/defaultChecker.js';
import {
  startWebhookRetryProcessor,
  stopWebhookRetryProcessor,
} from './services/webhookRetryProcessor.js';
import { eventStreamService } from './services/eventStreamService.js';
import {
  startNotificationDeliveryProcessor,
  stopNotificationDeliveryProcessor,
} from './services/notificationService.js';
import {
  startDataRetentionScheduler,
  stopDataRetentionScheduler,
} from './services/dataRetentionService.js';
import {
  startScoreReconciliationScheduler,
  stopScoreReconciliationScheduler,
} from './services/scoreReconciliationService.js';
import {
  startCrossContractReconciler,
  stopCrossContractReconciler,
} from './services/crossContractReconciler.js';
import { sorobanService } from './services/sorobanService.js';
import {
  startSubjectAccessExportProcessor,
  stopSubjectAccessExportProcessor,
} from './services/subjectAccessExportService.js';
import { validateLoanConfigOnStartup } from './config/loanConfig.js';
import { startLoanDueCheckCron, stopLoanDueCheckCron } from './cron/loanCheckCron.js';
import {
  startContractVerificationCron,
  stopContractVerificationCron,
} from './cron/contractVerificationJob.js';
// Imported the score decay scheduler initialization wrapper
import { startScoreDecayScheduler } from './cron/scoreDecayJob.js';
import { initializePauseState } from './middleware/pauseGuard.js';
import { shutdownCoordinator } from './middleware/shutdownHandler.js';
import {
  startSorobanWriteReplayProcessor,
  stopSorobanWriteReplayProcessor,
} from './services/sorobanWriteReplayProcessor.js';

const port = process.env.PORT || 3001;

// Termination budget shared with deployment config and the graceful-shutdown
// runbook. Must stay in sync with terminationGracePeriodSeconds in the
// deployment manifests so the process exits before the orchestrator SIGKILLs.
const SHUTDOWN_GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? 30000);

// Maintain a mutable handle to invoke clean scheduler closures on process stops
let scoreDecaySchedulerHandle: { stop: () => void } | null = null;

// Validate loan config on startup before accepting traffic
validateLoanConfigOnStartup();

// Validate score delta config on startup before accepting traffic
try {
  sorobanService.validateScoreConfig();
} catch (err) {
  logger.error('Startup configuration is invalid, aborting startup.', { err });
  process.exit(1);
}

// Validate Soroban contract IDs and RPC connectivity before accepting traffic
try {
  await sorobanService.validateConfig();
} catch (err) {
  logger.error('Soroban configuration is invalid, aborting startup.', { err });
  process.exit(1);
}

// Initialize pause state table and load initial state
try {
  await initializePauseState();
} catch (err) {
  logger.error('Failed to initialize pause state', { err });
  process.exit(1);
}

const server = app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);

  // Start the event indexer
  startIndexer();

  // Start periodic on-chain default checks (if configured)
  startDefaultCheckerScheduler();

  // Drain Soroban writes queued while the RPC was unavailable (#74)
  startSorobanWriteReplayProcessor();

  // Start webhook retry processor (5m/15m/45m backoff via WebhookService.processRetries)
  startWebhookRetryProcessor();

  // Start scheduled score reconciliation against on-chain state
  startScoreReconciliationScheduler();

  // Start cross-contract (disbursement <-> score) reconciliation ledger sweep
  startCrossContractReconciler();

  // Enforce the approved data-retention matrix in bounded, checkpointed batches.
  startDataRetentionScheduler();
  startNotificationDeliveryProcessor();

  startSubjectAccessExportProcessor();

  // Start loan due check cron
  startLoanDueCheckCron();

  // Start contract verification polling against Stellar explorer
  startContractVerificationCron();

  // Wire up and activate the score decay daily scheduler loop
  scoreDecaySchedulerHandle = startScoreDecayScheduler() || null;
});

let shuttingDown = false;

const shutdown = async (signal: 'SIGTERM' | 'SIGINT') => {
  // Concurrent SIGTERM/SIGINT must not run the drain sequence twice, which
  // could double-release leases or double-close the pool.
  if (shuttingDown) {
    logger.warn(`${signal} received while shutdown already in progress; ignoring.`);
    return;
  }
  shuttingDown = true;

  logger.info(`${signal} signal received: initiating graceful shutdown`);

  // Step 0: Flip readiness to not-ready so load balancers stop routing new
  // work before we begin draining. This must happen before any other step.
  shutdownCoordinator.beginShutdown();

  // Timeout force-kills if shutdown stalls past the shared termination budget.
  const timeout = setTimeout(() => {
    logger.error(
      `Graceful shutdown exceeded ${SHUTDOWN_GRACE_PERIOD_MS}ms, forcing exit. ` +
        'In-flight work is left retryable; leases are released by the drain steps below.',
    );
    process.exit(1);
  }, SHUTDOWN_GRACE_PERIOD_MS);
  timeout.unref();

  try {
    // Step 1: Stop accepting new requests and drain in-flight ones
    await shutdownCoordinator.shutdown();
    logger.info('In-flight requests drained or timeout reached.');

    // Step 2: Gracefully stop schedulers. Each stop() releases any held lease
    // and checkpoints progress so a restart resumes idempotently.
    logger.info('Stopping background schedulers...');
    if (scoreDecaySchedulerHandle) {
      scoreDecaySchedulerHandle.stop();
    }

    stopLoanDueCheckCron();
    stopContractVerificationCron();
    await stopIndexer();
    stopDefaultCheckerScheduler();
    stopWebhookRetryProcessor();
    stopSorobanWriteReplayProcessor();
    stopScoreReconciliationScheduler();
    stopCrossContractReconciler();
    stopDataRetentionScheduler();
    stopNotificationDeliveryProcessor();
    stopSubjectAccessExportProcessor();
    logger.info('All schedulers stopped.');

    // Step 3: Close event streams
    if (
      typeof (eventStreamService as unknown as { closeAll: (reason: string) => void }).closeAll ===
      'function'
    ) {
      (eventStreamService as unknown as { closeAll: (reason: string) => void }).closeAll(
        'Server shutting down',
      );
    } else if (typeof eventStreamService.closeAllConnections === 'function') {
      eventStreamService.closeAllConnections('Server shutting down');
    }

    // Step 4: Close HTTP server (stops listening, drains connections)
    logger.info('Closing HTTP server...');
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    logger.info('HTTP server closed.');

    // Step 5: Close database connections
    logger.info('Draining database pool...');
    await closePool();
    logger.info('Database pool drained.');

    // Step 6: Close Redis connection
    logger.info('Closing Redis connection...');
    // Note: cacheService.close() is implemented but not awaited in the service
    // This is a graceful close that won't block if Redis is unresponsive

    logger.info('Graceful shutdown completed successfully.');
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    logger.error('Graceful shutdown encountered errors', { signal, err });
    clearTimeout(timeout);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

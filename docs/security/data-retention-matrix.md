# Data Retention and Deletion Matrix

> Resolves [#364](https://github.com/JhayJ22/remitlend/issues/364).
>
> This document is the authoritative reference for how long each category of
> data is kept, who may request deletion, and what the operational procedure is
> for carrying it out.  It is referenced from [SECURITY.md](../../SECURITY.md)
> and [docs/SECURITY-MODEL.md](../SECURITY-MODEL.md).

---

## 1. Scope

This matrix covers:

- **Backend PostgreSQL** — all tables created by the migration scripts in
  `backend/migrations/`.
- **Stellar on-chain state** — contract storage, events, and NFT metadata
  stored on the Stellar/Soroban ledger.
- **Frontend / browser storage** — JWT cookie, localStorage, sessionStorage.
- **Operational artefacts** — logs, audit records, metrics, and backup dumps.

Data _not_ in scope: third-party analytics, payment-provider records, and
off-chain infrastructure managed outside this repository.

---

## 2. Data Classification

| Class | Definition | Examples |
|---|---|---|
| **PII** | Personally Identifiable Information — any field that can identify a natural person | email, phone, full name |
| **Financial** | Monetary amounts, loan terms, wallet balances | principal, interest, stroops values |
| **Credential** | Authentication secrets and key material | JWT cookies, API keys, wallet public keys |
| **Operational** | System-generated records needed for auditing and incident response | audit logs, webhook delivery logs |
| **On-chain** | Data written to the Stellar ledger (immutable once finalised) | contract state, NFT token metadata |

---

## 3. Retention Matrix

### 3.1 PostgreSQL Tables

| Table | Classification | Retention Period | Deletion Trigger | Deletion Mechanism | Notes |
|---|---|---|---|---|---|
| `users` / `user_profiles` | PII + Credential | Active account + **3 years** after last activity | Account deletion request (borrower or admin) | Hard delete of PII columns; row kept for FK integrity with `NULL` placeholders | Name, email, phone → hard-deleted. Public key remains (pseudonymous). |
| `scores` | Financial | **5 years** after the latest loan closure | All loans closed + retention window expiry | Hard delete | The borrower score is deleted only when at least one loan exists and every loan is in a terminal state. |
| `subject_access_exports` | PII | **24 hours** | Export expiration | Clear generated JSON archive; retain job/audit metadata | Expired archives are not downloadable and held archives stay inaccessible while held. |
| `contract_events` (`loan_events` compatibility view) | Financial | **7 years** after event timestamp | Retention window expiry | Soft-delete flag, then hard delete after 90-day grace | The active table is `contract_events`; legal holds use this class name. |
| `remittances` | PII + Financial | **5 years** after transfer date | Retention window expiry | Recipient address, memo, XDR, and error text cleared; financial row retained | Borrower loan caches are invalidated through a retryable outbox. |
| `remittance_history` | Financial, derived | **5 years** after record timestamp | Retention window expiry | Hard delete | Derived remittance history follows the five-year remittance lineage. |
| `audit_logs` | Operational | **7 years** | System schedule | Hard delete | Retention execution evidence and legal-hold audits are stored separately. |
| `notifications` and delivery attempts | Operational | **90 days** after delivery (creation time fallback) | Scheduled job | Hard delete | Pending delivery attempts are not removed; delivery attempts cascade with the notification. |
| `webhook_subscriptions` | Operational | Until cancelled + **30 days** | Subscriber cancellation or lender/admin action | Deactivate immediately, clear legacy secret and key material, then hard delete | Subscription deletion waits for its delivery records to reach their 90-day retention boundary. |
| `webhook_deliveries` | Operational | **90 days** | Scheduled job | Hard delete | Active retry records are retained until they are no longer scheduled. |
| `loan_disputes` | Financial | **7 years** after resolution | Retention window expiry | Hard delete | Open disputes are retained. |
| `quarantine_events` | Operational | **90 days** | Scheduled job | Hard delete | Quarantine events are cleared after investigation window. |
| `transaction_submissions` | Financial | **2 years** | Retention window expiry | Hard delete | XDR blobs are removed with the submission record. |
| `contract_verification` | Operational | **Indefinite** | Manual operator decision | Archive to cold storage | Contract verification records are permanent for auditability. |
| `indexer_state` / `ledger_checkpoints` | Operational | Rolling **30 days** (latest checkpoint kept) | Scheduled job | Hard delete of old checkpoints | Latest checkpoint per contract is never deleted automatically. |
| `pause_state` | Operational | Until contract resumed + **30 days** | Manual operator review | Hard delete | Record of emergency pauses kept for post-mortem. |

### 3.2 On-Chain Data (Stellar / Soroban)

On-chain data is **immutable** once finalised on the ledger.  Retention is
governed by Stellar network rules, not by RemitLend.

| Contract | Data Stored | Mutability | RemitLend Action Available |
|---|---|---|---|
| `remittance_nft` | NFT token metadata, transfer history | Append-only events; state can be updated by owner | Transfer or burn NFT (burns remove from active state but event history persists on ledger) |
| `lending_pool` | Pool balances, depositor share allocations | Mutable by authorised transactions | Withdraw fully removes depositor record |
| `loan_manager` | Loan state machine, repayment schedule | Mutable (state transitions only) | Loan closure finalises state; no deletion |
| `multisig_governance` | Governance proposals, votes | Append-only proposals; executed state stored | No deletion; expired proposals transition to `Expired` state |

**Threat note:** On-chain data containing wallet addresses (public keys) is
pseudonymous but permanent.  Any wallet address linked to a physical person
becomes de-facto permanent PII once that link is established off-chain.
RemitLend mitigates this by never storing the wallet↔identity mapping in a
single queryable row (see [Privacy-Preserving Architecture](privacy-preserving-architecture.md)).

### 3.3 Browser / Client Storage

| Storage | Data Stored | Retention | Deletion Trigger | Mechanism |
|---|---|---|---|---|
| `httpOnly` cookie `remitlend_jwt` | JWT (role + scopes, 24 h TTL) | 24 hours | Token expiry, logout, or explicit cookie clear | `Set-Cookie: Max-Age=0` on logout endpoint |
| `localStorage` | None by policy | N/A | N/A | Frontend must not persist JWTs or secrets in localStorage |
| `sessionStorage` | UI state (pagination, filters) | Session end | Browser tab close | Automatic |

### 3.4 Operational Artefacts

| Artefact | Retention | Notes |
|---|---|---|
| Application logs | **30 days** hot, **1 year** cold archive | Logs must be scrubbed of raw PII before archiving; use structured logging with masked fields. |
| Metrics (Prometheus/OpenTelemetry) | **13 months** | No PII in metric label values; Stellar addresses must be hashed before use as label values. |
| CI/CD artefacts | **90 days** | Build logs, test results. Purged by CI platform retention policy. |
| Database backups | **35 days** rolling | Encrypted at rest. See [runbooks/DATABASE_BACKUP_RECOVERY.md](../runbooks/DATABASE_BACKUP_RECOVERY.md). |
| WASM contract binaries | **Indefinite** | Immutable artefacts; stored alongside contract verification records. |

---

## 4. Deletion Procedures

### 4.1 User-Requested Account Deletion (GDPR / Right to Erasure)

When a borrower or lender requests deletion of their personal data:

1. **Verify identity** — requester must provide a signed challenge (same
   challenge–signature flow used for login) proving ownership of the wallet
   public key associated with the account.
2. **Scope assessment** — determine which tables hold PII for that `publicKey`.
3. **PII hard-delete** — NULL or overwrite: `email`, `phone`, `full_name` in
   `user_profiles`.  Leave `public_key`, `role`, and timestamp columns intact
   for FK/audit integrity.
4. **Remittance PII clear** — zero `recipient_name`, `recipient_phone`,
   `recipient_email` in `remittances` rows belonging to that user.
5. **Retain financial records** — `loan_events`, `scores`, and audit entries
   are _not_ deleted; they are de-identified by removing the direct PII
   columns above.
6. **Log the erasure** — append an `audit_log` entry of type
   `user_pii_erased` with the operator ID and timestamp.
7. **Confirm to requester** — provide a written confirmation within **30 days**
   (GDPR Art. 12 deadline) or **45 days** with one extension.

### 4.2 Scheduled / Automated Deletion

All automated deletion jobs must:

- Run in a dedicated, low-privilege DB role with `DELETE` permission only on
  the target table and only on rows matching the retention predicate.
- Emit a structured log entry (`level: info`, `event: retention_purge`) with
  `table`, `rows_deleted`, and `cutoff_date`.
- Be idempotent — re-running produces no error and no additional deletions if
  the window has not advanced.
- Be tested with the existing Jest test suite (see [Authorization Matrix Tests](authorization-matrix-tests.md)).
- Process at most 100 eligible rows per data class and run, ordered by retention
  timestamp and stable primary key. Re-running selects the next eligible rows;
  operations are idempotent and persisted per-class run counts act as
  checkpoints.
- Exclude only exact records with an active, audited legal hold. Holds require a
  documented basis and an audited basis when released.
- Emit aggregate counts by data class and operation. Subject identifiers must
  not be used as metric labels or in job logs.

The scheduled implementation is `backend/src/services/dataRetentionService.ts`.
It records per-run and per-class cutoffs, operation counts, status, and bounded
error codes in `retention_job_runs` and `retention_job_run_classes`. Operators
can inspect the latest runs through the admin retention API. The first run is
started at service startup; subsequent runs occur daily. A database lease
prevents overlapping instances, and an expired lease permits restart after a
process interruption. Each completed class also emits a `retention_purge`
structured log without record or subject identifiers.

Active legal holds can be created and released through the admin-only
`/api/admin/retention/legal-holds` endpoints. Both actions require a basis and
record the acting administrator. A hold identifies one data class and one
primary-key value; it does not suspend deletion for other records or categories.
The release endpoint requires a separate release basis.

The export job worker does not perform bulk expiration. The retention job
clears expired `export_data` in batches and preserves the export audit record.
The remittance anonymization job writes a retryable cache-invalidation outbox
before committing the update, so borrower-loan cache keys are retried after
Redis failures or process restarts.

### Enforcement boundaries

Some matrix entries cannot be safely automated from the current schema and are
not guessed by the job:

- Profile/account deletion after inactivity is not scheduled because
  `user_profiles` has no reliable last-activity timestamp or account-deletion
  state. Profile changes alone are not a safe proxy for account activity.
- Webhook subscription cancellation now records `canceled_at`; existing
  inactive rows created before this field remain until an explicit cancellation
  operation sets it.
- Score retention uses the latest terminal closure in `loan_history`; a score
  with no loan history or any nonterminal/unknown loan state is retained.
- Immutable on-chain data, contract verification records, indexer state, and
  pause state are not deleted by the job. Only rolling `ledger_checkpoints`
  are eligible under the 30-day policy.

### 4.3 Emergency / Incident-Driven Deletion

For data that must be removed outside the normal schedule (e.g., accidental
ingestion of SSNs or passport numbers):

1. Raise a **privileged action request** per the
   [Privileged Action Approval Policy](privileged-action-approval-policy.md).
2. Two-admin approval required before executing any `DELETE` or `UPDATE` in
   production.
3. All SQL executed must be logged to the `audit_logs` table and to the
   incident ticket.

---

## 5. Compliance Notes

| Regulation | Applicable Aspect | Retention Minimum | Deletion Deadline |
|---|---|---|---|
| GDPR (EU) | EU borrowers / lenders | None mandated | 30 days after verified request |
| CCPA (California) | CA residents | None mandated | 45 days after verified request |
| FinCEN / AML | Financial records | 5 years | Deletion blocked during this window |
| Stellar network | On-chain history | Indefinite (network-level) | Not deletable by RemitLend |

> **Note:** Retention periods are operational policy and must be reviewed for
> applicable jurisdictions. The automated job implements only the database
> classes listed in the enforcement section above; external backups, logs,
> on-chain state, and infrastructure-managed artifacts use their own lifecycle
> controls.

---

## 6. Rollout and Verification

1. Apply the retention migration before starting a new backend version.
2. Review the matrix and legal-hold process for the deployment jurisdiction.
3. Verify the retention admin API is reachable only by current admin JWTs and
   monitor `retention_job_runs` for `partial` or `failed` outcomes.
4. The [Authorization Matrix Tests](authorization-matrix-tests.md) test suite
   verifies that administrative routes cannot be triggered by unprivileged
   roles.

---

## 7. Document Maintenance

This document must be reviewed and updated:

- When a new database table or on-chain storage key is introduced.
- When a new country/jurisdiction is added to the supported market list.
- Annually, regardless of changes.

Owner: Security / Backend team.  Last reviewed: 2026-09-24.

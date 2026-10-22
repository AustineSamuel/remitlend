import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * After `requireJwtAuth`, ensures `req.params.loanId` refers to a loan whose
 * borrower matches the JWT `publicKey`.
 * Returns 404 both when the loan is missing and when it belongs to a different
 * borrower, so existence is not revealed.
 */
export const requireLoanBorrowerAccess = asyncHandler(async (req, _res, next) => {
  const loanId = req.params.loanId;
  const pk = req.user?.publicKey;
  const role = req.user?.role;

  if (!pk) {
    throw AppError.unauthorized('Authentication required');
  }
  if (!loanId) {
    throw AppError.badRequest('Loan ID is required');
  }

  // Admins and lenders are allowed to view loan details.
  if (role === 'admin' || role === 'lender') {
    return next();
  }

  const r = await query(`SELECT address FROM contract_events WHERE loan_id = $1 LIMIT 1`, [loanId]);

  const row = r?.rows?.[0] as { address: string } | undefined;
  if (!row) {
    throw AppError.notFound('Loan not found');
  }
  if (row.address !== pk) {
    // Same response as a missing loan so callers cannot probe for existence (#519).
    throw AppError.notFound('Loan not found');
  }

  next();
});

/**
 * After `requireJwtAuth`, ensures `req.params.txHash` (or `id`) refers to a
 * transaction submission owned by the caller (`transaction_submissions.submitted_by`
 * matches the JWT `publicKey`).
 * Returns 404 both when the transaction is missing and when it belongs to a
 * different user, so existence is not revealed (mirrors `requireLoanBorrowerAccess`).
 * Owner-only by default; admins are not granted implicit access.
 */
export const requireTransactionAccess = asyncHandler(async (req, _res, next) => {
  const txHash = req.params.txHash || req.params.id;
  const pk = req.user?.publicKey;

  if (!pk) {
    throw AppError.unauthorized('Authentication required');
  }
  if (!txHash) {
    throw AppError.badRequest('Transaction reference is required');
  }

  const r = await query(`SELECT submitted_by FROM transaction_submissions WHERE tx_hash = $1 LIMIT 1`, [
    txHash,
  ]);

  const row = r?.rows?.[0] as { submitted_by: string } | undefined;
  if (!row) {
    throw AppError.notFound('Transaction not found');
  }
  if (row.submitted_by !== pk) {
    // Same response as a missing transaction so callers cannot probe for existence (#519).
    throw AppError.notFound('Transaction not found');
  }

  next();
});

/**
 * After `requireJwtAuth`, ensures the authenticated user owns the loan specified in params.
 * Supports both `loanId` and `id` as parameter names.
 * Returns 404 when the loan is missing and 403 when it belongs to a different borrower.
 *
 * Ownership check (#1365): compare the loan's stored owner (`row.address`) to the
 * caller's JWT public key (`pk`). Never compare the caller key to itself.
 */
export const requireLoanOwner = asyncHandler(async (req, _res, next) => {
  const loanId = req.params.loanId || req.params.id;
  const pk = req.user?.publicKey;

  if (!pk) {
    throw AppError.unauthorized('Authentication required');
  }
  if (!loanId) {
    throw AppError.badRequest('Loan ID is required');
  }

  // Fetch loan borrower/owner from the unified view
  const r = await query(`SELECT address FROM loan_events WHERE loan_id = $1 LIMIT 1`, [loanId]);

  const row = r?.rows?.[0] as { address: string } | undefined;
  if (!row) {
    throw AppError.notFound('Loan not found');
  }

  const loanOwner = row.address;
  if (loanOwner !== pk) {
    // Same response as a missing loan so callers cannot probe for existence (#519).
    throw AppError.notFound('Loan not found');
  }

  next();
});

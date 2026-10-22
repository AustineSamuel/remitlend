# Borrower data export

Authenticated borrowers can request a short-lived, versioned JSON export:

- `POST /user/data-exports` queues one export for the authenticated wallet.
- `GET /user/data-exports/:id` returns owner-only job status.
- `GET /user/data-exports/:id/download` downloads the completed JSON archive.

The archive schema is versioned with `schemaVersion` and contains category
names, source names, source timestamps, and the gathered records. The current
export includes profile, remittance, remittance-history, score, loan-history, loan-event, notification, and
account-audit categories, capped at 1,000 rows per category. Categories include
a `truncated` flag when the cap is reached. Unavailable sources are listed in
`incompleteSources`; a partial export does not silently claim complete source
coverage.

Free-form profile metadata and remittance memos, remittance recipient details
and transaction XDR, notification contents, audit payloads and IP addresses,
credentials, authentication material, other borrowers' records, and restricted
fraud signals are excluded. Only fields selected in the export service are
included.

Jobs are processed outside the API request, allow one active job per borrower,
retry failed work at most three times, and expire after 24 hours. Export request,
generation, download attempt, successful download, denial, failure, and expiry
are recorded in the subject-access audit table. Downloads require the same
authenticated owner and return `Cache-Control: no-store`.

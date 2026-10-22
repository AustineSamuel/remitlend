# Notification delivery

External email and SMS delivery is tracked per logical notification and
channel in `notification_deliveries`. Each provider attempt and provider message
identifier is retained in `notification_delivery_attempts`. Provider acceptance
is not treated as confirmed delivery; normalized receipts update an attempt to
`delivered`, `retryable_failure`, or `permanent_failure`.

Retryable outcomes use capped exponential backoff with jitter and at most five
attempts. The processor claims at most 50 due deliveries per pass and recovers
stale in-progress attempts after five minutes. Provider failures and delivery
lag are exposed through aggregate Prometheus metrics; failure logs contain
bounded provider error codes and delivery identifiers, not message bodies or
recipient addresses.

An internal trusted integration can post normalized receipts to
`POST /api/internal/notification-receipts` with the existing internal request
signature. The body contains `provider` (`sendgrid` or `twilio`),
`providerMessageId`, `status`, and an optional bounded `errorCode`. Receipt
processing is idempotent for duplicate outcomes. The callback adapter must
verify provider-originated callbacks before forwarding them to this endpoint.

Cross-channel failover is deliberately narrow: only a permanently failed
`score_changed` email can queue SMS, and only while the borrower has SMS enabled
and a phone number on file. Other categories, including loan and security
notices, do not get a second-channel failover.

# Webhook Signature Verification

Every outbound webhook delivery from RemitLend includes an
`X-RemitLend-Signature` header that allows subscribers to verify the
payload was not tampered with in transit.

Signed deliveries also contain `X-RemitLend-Key-Id`. Use this identifier to
select exactly one versioned secret for verification. During rotation, retain
the old key only through the announced overlap window and return
`X-RemitLend-Key-Verified: <keyId>` after successfully verifying a delivery
with the new key.

## Header format

```
X-RemitLend-Signature: sha256=<hex-encoded-hmac>
```

The value is `sha256=` followed by the lowercase hex-encoded
HMAC-SHA256 digest of the **raw request body** using the subscriber
secret that was supplied when the subscription was registered.

## Verification recipe

### Node.js

```js
import crypto from "node:crypto";

function verifySignature(secret, rawBody, signatureHeader) {
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Use timingSafeEqual to prevent timing attacks
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Express example — select the one-time-disclosed secret by key ID.
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["x-remitlend-signature"];
  const keyId = req.headers["x-remitlend-key-id"];
  const secret = secretsByKeyId.get(keyId);
  if (!secret || !verifySignature(secret, req.body, sig)) {
    return res.status(401).send("Invalid signature");
  }
  res.setHeader("X-RemitLend-Key-Verified", keyId);
  // process req.body …
  res.sendStatus(200);
});
```

### Python

```python
import hmac, hashlib

def verify_signature(secret: str, raw_body: bytes, header: str) -> bool:
    digest = "sha256=" + hmac.new(
        secret.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(digest, header or "")
```

## Notes

- The `Authorization: Bearer <secret>` header is also present for
  backwards compatibility with existing subscribers that have not yet
  adopted HMAC verification, but **`X-RemitLend-Signature` is the
  authoritative integrity check**.
- Always parse the raw body bytes *before* JSON-decoding; most
  frameworks let you configure a raw-body parser for webhook routes.
- Secrets are disclosed only on subscription creation and the first successful
  response to a rotation request. See [webhook consumer migration and
  compromise response](../webhooks.md#signing-key-rotation).

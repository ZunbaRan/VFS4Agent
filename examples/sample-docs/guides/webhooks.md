# Webhooks

Webhooks deliver events to your server in real time.

## Subscribe

```bash
POST /v1/webhooks
{
  "url": "https://yourapp.com/hook",
  "events": ["order.created", "order.paid"]
}
```

## Verify signatures

Each delivery includes `X-Signature: sha256=...`.

```python
import hmac, hashlib
expected = hmac.new(secret, body, hashlib.sha256).hexdigest()
```

Reject deliveries whose signature does not match.

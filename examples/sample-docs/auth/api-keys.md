# API Keys

For server-to-server usage where OAuth is overkill, generate an API key
from the dashboard.

## Create a key

```bash
POST /v1/api-keys
{
  "name": "my-service",
  "scopes": ["read:users", "write:orders"]
}
```

Keys are shown ONCE. Store them in a secret manager.

## Revoke a key

```bash
DELETE /v1/api-keys/{id}
```

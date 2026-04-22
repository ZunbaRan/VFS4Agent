# Quickstart

Get started in 5 minutes.

1. Sign up at https://example.com
2. Create an API key (see [API Keys](../auth/api-keys.md))
3. Generate an access_token via OAuth (see [OAuth](../auth/oauth.md))
4. Make your first call:

```bash
curl https://api.example.com/v1/ping \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Expected response: `{"pong": true}`.

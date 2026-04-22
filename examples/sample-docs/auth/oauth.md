# OAuth Authentication

This guide shows how to authenticate with the API using OAuth 2.0.

## Get an access_token

Make a POST request to the token endpoint:

```bash
curl -X POST https://api.example.com/oauth/token \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET"
```

The response contains an `access_token` that expires in 3600 seconds.

## Use the access_token

Pass the token in the `Authorization` header on every request:

```bash
curl https://api.example.com/v1/users \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Tokens MUST be refreshed before expiry. See [Token Refresh](./token-refresh.md).

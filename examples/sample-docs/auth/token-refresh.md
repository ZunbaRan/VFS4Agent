# Token Refresh

Access tokens expire after 3600 seconds. Refresh before expiry.

```bash
curl -X POST https://api.example.com/oauth/token \
  -d "grant_type=refresh_token" \
  -d "refresh_token=$REFRESH_TOKEN"
```

The response contains a new `access_token` and rotates `refresh_token`.
Old refresh tokens are invalidated after the swap.

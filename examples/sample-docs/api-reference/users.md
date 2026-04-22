# GET /users

Returns a list of users.

## Request

```
GET /v1/users
Authorization: Bearer <access_token>
```

## Response

```json
{ "users": [{ "id": "u_1", "name": "Alice" }] }
```

Requires `read:users` scope.

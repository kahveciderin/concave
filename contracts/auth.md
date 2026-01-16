# Authentication Contracts

## Guarantees

### Token Validation
- **Required claims checked**: `iss`, `aud`, `exp` are always validated
- **Algorithm enforcement**: Only configured algorithms accepted; `none` always rejected
- **Clock skew tolerance**: Configurable tolerance for `exp`, `nbf`, `iat` checks
- **Signature verification**: All tokens are cryptographically verified

### OIDC Compliance
- **Discovery support**: `/.well-known/openid-configuration` endpoint provided
- **PKCE required**: Public clients must use PKCE (code_challenge)
- **State validation**: `state` parameter validated on callback

### Session Security
- **Session rotation**: Session ID rotated on login (prevents fixation)
- **Logout invalidation**: All session tokens invalidated on logout
- **Cookie security**: HttpOnly, Secure, SameSite attributes set

### Multi-Tenant
- **Issuer isolation**: Same `sub` from different `iss` = different users
- **Issuer whitelist**: Only configured issuers accepted

## Non-Guarantees

### Token Lifetime (What We Don't Promise)
- ❌ **Minimum lifetime**: Tokens may be revoked at any time
- ❌ **Refresh success**: Refresh tokens may be revoked or expired
- ❌ **Grace period**: No grace period after token expiration

### Availability (What We Don't Promise)
- ❌ **JWKS availability**: JWKS endpoint may be temporarily unavailable
- ❌ **Session persistence**: Sessions may be cleared (e.g., server restart with memory store)

## Threat Model

### In Scope (Protected Against)
- Token forgery
- Token replay (with nonce)
- Session fixation
- CSRF (with state parameter)
- Algorithm confusion attacks
- JWT injection via `none` algorithm

### Out of Scope (Not Protected Against)
- Compromised signing keys (operational security)
- Client-side token theft (XSS)
- Phishing attacks
- Brute force (rate limiting helps but doesn't eliminate)
- Side-channel attacks

## Rate Limiting

### Auth Endpoints
- Login: 5 attempts per 15 minutes per IP
- Token refresh: 10 per minute per user
- Password reset: 3 per hour per email

### Rate Limit Bypass Protection
- Header normalization (case-insensitive)
- IP normalization (IPv4/IPv6)
- X-Forwarded-For only from trusted proxies

## Failure Modes

### Invalid Token
- Returns 401 Unauthorized
- Clear error message (without leaking info)
- No retry (client must re-authenticate)

### JWKS Unavailable
- Use cached keys if available
- Return 503 if no cached keys
- Automatic retry with backoff

### Session Expired
- Returns 401 Unauthorized
- Client should redirect to login
- Refresh token may still be valid

## Test Coverage

- `tests/invariants/auth-hardening.test.ts` - Security edge cases
- `tests/auth.test.ts` - Basic authentication
- `tests/auth-routes.test.ts` - Auth endpoints
- `tests/oidc/provider.test.ts` - OIDC provider

# Signals UI Authentication and API Proxy — Technical Specification


> Repository mapping: the **SPA** is `apps/web`, the **API Server** (auth + proxy) is `apps/proxy-api`, and the **Signals Backend API** is `apps/api`. The proxy forwards registered operations to the backend over internal networking; the backend re-validates the forwarded session against the shared database and is never reachable from the browser.

## 1. Architecture and Component Responsibilities

The Signals UI system consists of two internal components — a Single-Page Application (SPA) and an API Server — plus external dependencies on Keycloak and the Signals Backend API. No component in the authentication or proxy path is directly exposed to the public internet beyond the SPA's static asset delivery.

**SPA (Single-Page Application)**

Responsible for rendering the user interface and initiating all user-driven actions. The SPA does not manage tokens, session identifiers, or authentication state directly. It delegates all authentication and API calls to the API Server. Cookies are sent automatically by the browser; the SPA never reads, stores, or forwards them via JavaScript.

**API Server**

The authoritative component for all security-sensitive operations. Responsibilities include:

- Initiating the Keycloak OAuth 2.0 / OIDC authorization code flow
- Processing the Keycloak callback and exchanging codes for tokens
- Creating, validating, and invalidating sessions
- Storing and renewing access tokens and refresh tokens
- Implementing the centralized proxy for all authenticated backend API calls
- Enforcing authorization controls on proxied operations
- Performing Keycloak logout and token revocation

The API Server is accessible only to the SPA server and authorized internal infrastructure. It is not reachable from the public internet.

**Session and Token Database**

A server-side data store (e.g., PostgreSQL or Redis) holding session records, access tokens, refresh tokens, and expiry timestamps. Accessible only to the API Server.

**Keycloak (Identity Provider)**

External OIDC-compliant identity provider. Responsible for authenticating users, issuing authorization codes, and providing tokens. The API Server communicates with Keycloak server-to-server for token exchange, refresh, and logout.

**Signals Backend API**

The downstream application API. Receives forwarded requests from the API Server only — never directly from the browser or SPA.

### Responsibility Matrix

| Concern | SPA | API Server | DB | Keycloak |
| --- | --- | --- | --- | --- |
| Render UI | ✓ |  |  |  |
| Initiate login | ✓ (redirect) | ✓ (builds URL) |  |  |
| Token exchange |  | ✓ |  | ✓ |
| Session management |  | ✓ | ✓ |  |
| Cookie issuance |  | ✓ |  |  |
| Token storage |  |  | ✓ |  |
| API proxy |  | ✓ |  |  |
| User authentication |  |  |  | ✓ |
| Token revocation |  | ✓ |  | ✓ |

## 2. Authentication Flows

### 2.1 Login Flow

1. User navigates to a protected route. The SPA calls `GET /auth/login` on the API Server.
2. The API Server generates a cryptographically random `state` parameter and `code_verifier` / `code_challenge` pair (PKCE). It stores these in a short-lived, server-side pending-login record (keyed by `state`, TTL \~10 minutes).
3. The API Server constructs the Keycloak authorization URL and returns it (or issues a redirect) to the SPA.
4. The SPA redirects the browser to the Keycloak authorization URL.
5. Keycloak authenticates the user and redirects back to the API Server's callback URL with an `authorization_code` and the original `state`.
6. **Callback handling** (`GET /auth/callback`):
   - The API Server validates the `state` against the pending-login record. A missing or mismatched `state` is rejected with `400 Bad Request`.
   - The API Server exchanges the `authorization_code` + `code_verifier` for tokens via a server-to-server POST to Keycloak's token endpoint.
   - Tokens and expiry timestamps are stored in the database under a new, randomly generated `session_id`.
   - A `Set-Cookie` header issues the `session_id` as a `HttpOnly; Secure; SameSite=Lax` (or `Strict`) cookie with an appropriate `Max-Age`.
   - The API Server redirects the browser to the SPA's post-login destination.
7. On subsequent requests, the browser automatically sends the session cookie. The SPA has no visibility into the session ID or any token value.

### 2.2 Token Renewal Flow

Token renewal is performed transparently by the API Server on any proxied request where the access token is found to be expired or approaching expiry (configurable threshold, e.g., within 60 seconds of expiry).

1. The API Server detects token near-expiry or expiry when processing a proxy request.
2. It acquires a per-session distributed lock to prevent concurrent renewal races (see Section 6).
3. It POSTs to Keycloak's token endpoint using the stored refresh token.
4. On success: the new access token, refresh token (if rotated), and updated expiry timestamps are written back to the database. The proxy request proceeds with the new access token.
5. On failure (e.g., refresh token expired or revoked): the session is invalidated, the session cookie is cleared, and a `401 Unauthorized` is returned to the SPA, which then redirects the user to login.

### 2.3 Logout Flow

1. The SPA calls `POST /auth/logout` (session cookie sent automatically by the browser).
2. The API Server validates the session cookie and looks up the session.
3. The session record is deleted from the database.
4. The API Server issues a `Set-Cookie` header that clears the session cookie (empty value, `Max-Age=0`).
5. If Keycloak supports RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0), the API Server performs a server-to-server logout call or returns a redirect URL for the browser to complete front-channel logout at Keycloak. If a refresh token is held, it is also revoked via Keycloak's revocation endpoint.
6. The SPA redirects to the logged-out state or login page.

### 2.4 Session Validation on Proxy Requests

For every request reaching the proxy middleware:

1. The session cookie is extracted from the request.
2. The session ID is looked up in the database.
3. If no record is found, or the record is expired: return `401 Unauthorized`.
4. If the access token is valid and not near-expiry: proceed.
5. If the access token is near-expiry or expired: execute the renewal flow (Section 2.2) before proceeding.

## 3. Session and Token Database Schema

### 3.1 `sessions` Table

| Column | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `session_id` | `TEXT` | PRIMARY KEY | Keycloak `sub` claim — stable opaque UUID. Never changes even if email or username changes. Primary user identifier for any user-linked data. If Keycloak federates Azure AD, the MS OID (`oid` claim) arrives via Keycloak and can be stored in a dedicated column if MS Graph correlation is needed. |
| `user_id` | `TEXT` | NOT NULL | User token identifier — subject claim (`sub`) from the Keycloak ID token. |
| `email` | `TEXT` | NULLABLE | Email from the Keycloak \`email\` claim. For audit and display only — not used as an identifier. Updated on each login. Null if the provider does not supply it. |
| `access_token` | `TEXT` | NOT NULL | Encrypted at rest. Current Keycloak access token. |
| `refresh_token` | `TEXT` | NULLABLE | Encrypted at rest. Null if Keycloak does not issue one. |
| `token_expires_at` | `TIMESTAMPTZ` | NOT NULL | UTC expiry of the current valid token. Updated on every renewal. Also stored in the session cookie so the SPA can detect expiry client-side without exposing the token itself. |
| `— (removed)` | `TIMESTAMPTZ` | NULLABLE | Removed. Refresh token expiry is not tracked separately. The server attempts renewal when token\_expires\_at is breached and handles Keycloak rejection inline. |
| `session_expires_at` | `TIMESTAMPTZ` | NOT NULL | Absolute session expiry enforced independently of token expiry. |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW() | Session creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW() | Last updated (on every token renewal). |
| `renewal_lock` | `TEXT` | NULLABLE | Distributed lock identifier for concurrent renewal prevention. |
| `ip_address` | `TEXT` | NULLABLE | Client IP at session creation (for audit/logging; not used for enforcement). |
| `user_agent` | `TEXT` | NULLABLE | Browser UA at session creation (for audit). |

**Indexes:**

- `session_id` — primary key (already indexed)
- `session_expires_at` — to support periodic cleanup of expired sessions
- `user_id` — to support forced logout of all sessions for a user

### 3.2 `Login State Cookie`e

The `state` and `code_verifier` values only need to survive the browser redirect round-trip. Rather than a database table, these are stored in a short-lived, signed, encrypted `HttpOnly` cookie set immediately before the Keycloak redirect — no table, no cleanup job, no concurrent-write concern.

**Cookie name:** `oauth_state` — `HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/callback`

**Payload (signed JWT, encrypted using the server key):**

| Field | Description |
| --- | --- |
| `state` | Random CSRF value. Validated against the `state` query param on callback. |
| `code_verifier` | PKCE code verifier (S256). Used in the token exchange call. |
| `redirect_uri` | Must match the redirect URI sent to Keycloak exactly. |
| `post_login_path` | SPA route to redirect to after successful login. |
| `exp` | 10 minutes from issue. |

On callback, the API Server verifies the cookie (signature + expiry), extracts the values, clears the cookie (`Max-Age=0`), and proceeds with the token exchange.

**Future scope:** A database-backed `pending_logins` table can be added later for login-attempt auditing or multi-device flows without changing the rest of the auth flow.

| Column | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `state` | `TEXT` | PRIMARY KEY | Random CSRF state value. |
| `code_verifier` | `TEXT` | NOT NULL | PKCE code verifier (S256). |
| `redirect_uri` | `TEXT` | NOT NULL | The redirect URI sent to Keycloak; must match on exchange. |
| `post_login_path` | `TEXT` | NULLABLE | SPA path to redirect to after successful login. |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL | Short TTL, e.g., 10 minutes from creation. |
| `created_at` | `TIMESTAMPTZ` | NOT NULL DEFAULT NOW() |  |

**Cleanup:** Expired rows in both tables should be removed by a periodic background job or database-level TTL mechanism to prevent unbounded growth.

### 3.3 Token Encryption

Access tokens and refresh tokens must be encrypted at rest using a server-managed symmetric key (e.g., AES-256-GCM). The encryption key must be stored in a secrets manager (e.g., HashiCorp Vault, AWS Secrets Manager) and not in the database or application configuration files. Key rotation must be supported without service interruption.

### 3.4 Session Store: PostgreSQL (Redis as Future Scope)

PostgreSQL is the session store. It supports audit logging, cross-session user queries, and durable history. The `sessions` table is the single source of truth for all active user tokens.

**Future scope — Redis:** Redis may be introduced later as a caching layer in front of PostgreSQL for high-throughput deployments (the session lookup happens on every proxy request). When introduced, Redis holds a short-TTL copy keyed by `session:{session_id}`; the PostgreSQL row remains authoritative for all writes (renewal, invalidation)..&#32;

- Key: `session:{session_id}` — serialized session record (JSON or MessagePack), TTL set to `session_expires_at`.
- Key: `pending_login:{state}` — serialized pending-login record, TTL set to `expires_at`.
- Key: `renewal_lock:{session_id}` — lock key with a short TTL (e.g., 10 seconds) for concurrent renewal control.

A relational database is preferred if audit logging, cross-session user queries, or durable history are required.

## 4. API Contracts

### 4.1 Authentication Endpoints

These endpoints handle authentication lifecycle operations and are explicitly excluded from the general-purpose proxy middleware.

#### `GET /auth/login`

Initiates the Keycloak authorization code flow.

**Request:** No body. Optional query parameter `?next=<url-encoded-path>` to specify the post-login SPA route.

**Response:** `302 Found` — redirect to Keycloak authorization URL. The `state` and PKCE values are persisted server-side before the redirect.

**Error:** `500 Internal Server Error` if state persistence fails.

---

#### `GET /auth/callback`

Keycloak redirects here after user authentication.

**Request:** Query parameters `code` (authorization code) and `state` (must match stored state).

**Response:**

- Success: `302 Found` — redirect to SPA with `Set-Cookie: session_id=<value>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<seconds>`.
- `400 Bad Request` — missing, invalid, or expired `state`.
- `401 Unauthorized` — Keycloak token exchange failed.
- `500 Internal Server Error` — session persistence failure.

---

#### `POST /auth/logout`

Invalidates the current session and clears the session cookie.

**Request:** No body. Session cookie must be present.

**Response:**

- `204 No Content` — session invalidated. `Set-Cookie` header clears the cookie.
- `401 Unauthorized` — no valid session cookie.

**Side effects:** Deletes session from DB; revokes refresh token and/or invokes Keycloak RP-initiated logout if configured.

---

### 4.2 Centralized Proxy Endpoint

#### `POST /api/proxy`

All authenticated application API calls pass through this single endpoint. Login and logout endpoints are explicitly excluded.

**Request Headers:** `Cookie: session_id=<value>` (sent automatically by browser). `Content-Type: application/json`.

**Request Body:**

```json
{
  "method": "GET | POST | PUT | PATCH | DELETE",
  "path": "/signals/api/v1/some/resource",
  "queryParams": {
    "key": "value"
  },
  "payload": { },
  "headers": {
    "X-Correlation-Id": "abc123"
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `method` | Yes | HTTP method. Must be one of the allowlisted methods. |
| `path` | Yes | Target backend path. Must match a registered/allowlisted pattern. |
| `queryParams` | No | Key-value map of query parameters to append to the backend URL. |
| `payload` | No | JSON body forwarded to the backend. Only applicable for `POST`, `PUT`, `PATCH`. |
| `headers` | No | Optional headers from an explicit allowlist. Security-sensitive headers (`Authorization`, `Cookie`, `Host`, etc.) are blocked regardless of what is passed here. |

**Successful Response:**

```json
{
  "status": 200,
  "body": { },
  "headers": {
    "X-Request-Id": "xyz"
  }
}
```

The `status` reflects the Signals backend's HTTP status code. The `body` is the backend response payload. The `headers` map contains only explicitly permitted response headers.

**Error Responses:**

| HTTP Status | Condition |
| --- | --- |
| `400 Bad Request` | Malformed proxy request (invalid method, missing path, schema validation failure). |
| `401 Unauthorized` | No valid session cookie; session expired; token renewal failed. |
| `403 Forbidden` | Requested backend path not in allowlist; blocked header detected. |
| `408 Request Timeout` | Backend call exceeded configured timeout. |
| `502 Bad Gateway` | Backend returned an unexpected error or could not be reached. |
| `503 Service Unavailable` | All retry attempts exhausted. |

---

### 4.3 Session Status Endpoint (Optional)

#### `GET /auth/session`

Allows the SPA to check whether a valid session exists without triggering a full proxy call. Returns minimal, non-sensitive session metadata.

**Response:**

```json
{
  "authenticated": true,
  "expiresAt": "2026-10-15T14:00:00Z"
}
```

- `401 Unauthorized` if no valid session cookie is present.

## 5. Proxy Request Validation, Target Resolution, Header Handling, and Response Forwarding

### 5.1 Request Validation

The proxy middleware validates each incoming request before performing any session lookup or backend call:

1. **Schema validation:** The request body must conform to the proxy request schema (Section 4.2). Missing or malformed fields are rejected with `400 Bad Request`.
2. **Method allowlist:** Only explicitly permitted HTTP methods are accepted. Recommended allowlist: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Any other method is rejected with `400 Bad Request`.
3. **Path validation:** The `path` field must match a registered backend operation. See Section 5.2.
4. **Header validation:** Request `headers` field is filtered against an explicit allowlist. Any header that appears on the blocked list is stripped or causes a `403 Forbidden`. See Section 5.3.
5. **Payload constraint:** A `payload` body is only forwarded for methods that support a request body (`POST`, `PUT`, `PATCH`). Payloads on `GET` or `DELETE` requests are dropped.

### 5.2 Target Resolution and SSRF Prevention

The proxy must not accept arbitrary URLs. Target resolution works as follows:

- A **registered operation registry** is maintained on the API Server — a static or dynamically loaded map of permitted backend path patterns and their corresponding resolved base URL prefix on the Signals Backend API.
- The `path` value in the proxy request is matched against this registry using exact-match or prefix-match rules (e.g., regex or glob patterns). Only paths that match a registered pattern are permitted.
- The resolved backend URL is constructed by the API Server by joining the configured `SIGNALS_BACKEND_BASE_URL` with the validated `path`. The caller cannot override or inject the base URL.
- Path traversal sequences (`../`, `%2e%2e`, etc.) are normalized and rejected if they escape the permitted prefix.
- The registry must be reviewed and updated as backend operations change. Unknown or unregistered paths return `403 Forbidden`.

**Example registry entry:**

```
Pattern: /signals/api/v1/events*
Allowed methods: GET, POST
Description: Event data access
```

### 5.3 Header Handling

**Inbound headers (SPA → API Server → Backend):**

| Header | Handling |
| --- | --- |
| `Authorization` | Always blocked. The API Server sets this itself from the stored access token. |
| `Cookie` | Always blocked. Session cookies must not be forwarded to the backend. |
| `Host` | Always blocked. Set by the HTTP client library based on the backend URL. |
| `X-Forwarded-For` | Stripped or passed through per deployment policy (not from the caller's headers). |
| `Content-Type` | Forwarded if applicable and within allowlist. |
| `X-Correlation-Id` | Forwarded if present (example of a permitted custom header). |
| Any other header | Blocked unless on the explicit allowlist. |

The `Authorization` header is always set by the API Server as `Bearer <access_token>` and must never be controlled or overridden by the caller.

**Outbound headers (Backend → API Server → SPA):**

Only headers on an explicit response header allowlist are forwarded back to the SPA. Security-sensitive backend response headers (e.g., `Set-Cookie`, `WWW-Authenticate`) are not forwarded. Suggested permitted response headers:

- `Content-Type`
- `X-Request-Id`
- `X-Correlation-Id`
- `Cache-Control`

### 5.4 Response Forwarding

1. The API Server makes the outbound HTTP request to the backend using the resolved URL, the validated method, the filtered headers (plus the injected `Authorization`), and the forwarded payload.
2. The backend's HTTP status code is included in the proxy response body as `status`.
3. The backend response body is forwarded as-is (assuming JSON) in the `body` field.
4. Only allowlisted response headers are included in the `headers` field of the proxy response.
5. HTTP-level errors from the backend (4xx, 5xx) are forwarded as-is in the `status` field — the proxy itself still returns `200 OK` at the HTTP transport layer (wrapping the backend's status), unless the error is one of the proxy's own error conditions (session invalid, SSRF blocked, etc.).

**Note:** An alternative design is to propagate the backend's status code directly as the HTTP response status. This is simpler but may conflict with SPA error handling that distinguishes proxy errors from backend errors. This is an open design decision (see Section 10).

## 6. Error Handling, Security Controls, Concurrency, Retries, and Token Expiry

### 6.1 Error Handling

**Session errors:** All session-validation failures return `401 Unauthorized`. The response body must not contain information about whether the session ID was not found, was expired, or was malformed — a generic error message only. The SPA should interpret `401` as a signal to redirect the user to the login flow.

**Token renewal failures:** If a refresh token is expired, revoked, or absent, the session is invalidated and a `401 Unauthorized` is returned. The failure must be logged server-side with sufficient context for diagnosis but without logging token values.

**Backend errors:** Backend HTTP errors (4xx, 5xx) are propagated to the SPA as described in Section 5.4. Network errors and timeouts from the backend result in `502 Bad Gateway` or `408 Request Timeout` respectively.

**Validation errors:** `400 Bad Request` with a structured error body identifying the offending field:

```json
{ "error": "validation_error", "field": "method", "detail": "Method 'TRACE' is not permitted." }
```

**Internal errors:** `500 Internal Server Error` for unexpected failures. The response body contains only a generic message. Stack traces and internal details must not be returned to the client.

### 6.2 Security Controls

- **HttpOnly cookie:** The session cookie is set with `HttpOnly` to prevent JavaScript access. The SPA must not attempt to read, forward, or store the cookie.
- **Secure flag:** The `Secure` flag must be set on the session cookie in all HTTPS environments. HTTP is only permitted for local development.
- **SameSite:** `SameSite=Lax` is the recommended default. `SameSite=Strict` may be used if the application does not rely on top-level navigation carrying the cookie. `SameSite=None` must not be used unless strictly required and only with `Secure`.
- **CSRF protection:** With `SameSite=Lax` or `Strict`, cross-site request forgery is substantially mitigated for modern browsers. For defense-in-depth, the API Server may additionally require a custom request header (e.g., `X-Requested-With: XMLHttpRequest`) on all proxy requests, which is not sent by cross-site forms.
- **Token logging:** Access tokens, refresh tokens, and session IDs must never appear in application logs, request logs, or error traces. Log the `user_id` and a truncated/hashed session reference for correlation purposes only.
- **State parameter:** The OAuth `state` parameter used during login must be cryptographically random, stored server-side, and validated on callback. It is consumed and deleted after a single use.
- **PKCE:** The `code_verifier` and `code_challenge` must be generated per-login attempt and stored server-side in the `pending_logins` table. PKCE S256 is required.
- **Authorization enforcement:** A valid session is necessary but not sufficient. The proxy must verify that the requested backend path is in the allowlist. Additional per-operation authorization checks (e.g., role-based access control against Keycloak claims) may be layered in the proxy middleware as required by the Signals application.
- **Secret storage:** Client secrets, database credentials, and encryption keys are stored exclusively in a secrets manager. They are not present in environment variable files checked into version control.

### 6.3 Concurrent Token Renewal

When multiple simultaneous proxy requests arrive for the same session and the token is near-expiry, only one renewal attempt must proceed at a time.

**Mechanism:**

1. Before renewal, the API Server attempts to acquire a distributed lock keyed to `session_id` (e.g., a Redis `SET NX PX <ttl>` or a database advisory lock).
2. If the lock is acquired, renewal proceeds. On completion, the lock is released and the new token is written to the database.
3. If the lock is not acquired (another request is renewing), the waiting request polls or retries until the lock is released, then reads the freshly renewed token from the database.
4. Lock TTL must exceed the expected Keycloak token-exchange latency with a margin (e.g., 10–15 seconds). If the lock TTL expires without renewal completing (e.g., Keycloak was unreachable), the lock is released and the next attempt may retry.

### 6.4 Retries

Retry logic applies to backend API calls (proxy) and to Keycloak token operations:

| Operation | Retry strategy |
| --- | --- |
| Backend proxy call | 1 retry on `502` or network error. No retry on `4xx`. Exponential backoff: 200 ms, then 400 ms. |
| Keycloak token exchange | 1 retry on transient network error (5xx or timeout). No retry on `4xx` (invalid grant, etc.). |
| Keycloak refresh | Same as token exchange. |

All retries must be idempotent. Non-idempotent operations (`POST`, `PATCH`) are retried only if the backend explicitly signals idempotency (e.g., via a request-scoped idempotency key) or if the error occurred before the request reached the backend.

### 6.5 Timeouts

| Operation | Recommended Timeout |
| --- | --- |
| Keycloak token exchange | 5 seconds |
| Keycloak refresh | 5 seconds |
| Backend proxy call | 30 seconds (configurable per operation) |
| DB session lookup | 2 seconds |
| DB session write | 3 seconds |

All timeouts are configurable via environment variables. Timeout values must be documented and reviewed against observed backend latency profiles.

### 6.6 Token Expiry Behavior

| Condition | Behavior |
| --- | --- |
| Access token valid, not near-expiry | Proceed with stored token. |
| Access token near-expiry (within threshold) | Attempt renewal before forwarding. |
| Access token expired, refresh token valid | Attempt renewal; proceed if successful. |
| Access token expired, refresh token expired | Invalidate session; return `401`. |
| Access token expired, no refresh token | Invalidate session; return `401`. |
| Session record missing or expired | Return `401`. |

## 7. Environment Variables and Configuration Management

All configuration is provided through environment variables. No secrets appear in source code, configuration files committed to version control, or application logs.

### 7.1 Keycloak Configuration

| Variable | Description | Example |
| --- | --- | --- |
| `KEYCLOAK_BASE_URL` | Base URL of the Keycloak server. | `https://auth.example.com` |
| `KEYCLOAK_REALM` | Keycloak realm name. | `signals` |
| `KEYCLOAK_CLIENT_ID` | OAuth 2.0 client ID registered in Keycloak. | `signals-ui` |
| `KEYCLOAK_CLIENT_SECRET` | OAuth 2.0 client secret. **Secrets manager only.** | *(secret)* |
| `KEYCLOAK_REDIRECT_URI` | Callback URL registered in Keycloak. Must match exactly. | `https://app.example.com/auth/callback` |
| `KEYCLOAK_SCOPES` | Space-separated OIDC scopes to request. | `openid profile email offline_access` |
| `KEYCLOAK_LOGOUT_REDIRECT_URI` | Post-logout redirect URI sent to Keycloak (RP-Initiated Logout). | `https://app.example.com/` |

### 7.2 Session and Cookie Configuration

| Variable | Description | Default / Example |
| --- | --- | --- |
| `SESSION_COOKIE_NAME` | Name of the session cookie. | `signals_session` |
| `SESSION_COOKIE_SECURE` | Set the `Secure` flag. Must be `true` in production. | `true` |
| `SESSION_COOKIE_SAMESITE` | `Lax`, `Strict`, or `None`. | `Lax` |
| `SESSION_COOKIE_MAX_AGE_SECONDS` | Cookie lifetime in seconds. | `28800` (8 hours) |
| `SESSION_ABSOLUTE_EXPIRY_SECONDS` | Maximum session duration regardless of token renewal. | `86400` (24 hours) |
| `TOKEN_RENEWAL_THRESHOLD_SECONDS` | Time before access token expiry at which renewal is triggered. | `60` |

### 7.3 Database Configuration

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Full connection string for the session/token database. **Secrets manager only.** |
| `DATABASE_POOL_MIN` | Minimum connection pool size. |
| `DATABASE_POOL_MAX` | Maximum connection pool size. |
| `TOKEN_ENCRYPTION_KEY` | Base64-encoded AES-256 key for encrypting tokens at rest. **Secrets manager only.** |

### 7.4 Proxy and Backend Configuration

| Variable | Description | Example |
| --- | --- | --- |
| `SIGNALS_BACKEND_BASE_URL` | Base URL of the Signals Backend API. Not caller-controlled. | `https://backend.internal/` |
| `PROXY_BACKEND_TIMEOUT_MS` | Timeout for backend proxy calls in milliseconds. | `30000` |
| `PROXY_ALLOWED_METHODS` | Comma-separated list of permitted HTTP methods. | `GET,POST,PUT,PATCH,DELETE` |
| `PROXY_ALLOWED_REQUEST_HEADERS` | Comma-separated list of headers the SPA may pass through. | `X-Correlation-Id,Content-Type` |
| `PROXY_ALLOWED_RESPONSE_HEADERS` | Comma-separated list of backend response headers forwarded to the SPA. | `Content-Type,X-Request-Id,Cache-Control` |
| `PROXY_OPERATION_REGISTRY_PATH` | Path to the JSON or YAML file defining the allowed backend operation patterns. | `/etc/signals/proxy-registry.yaml` |

### 7.5 Application Configuration

| Variable | Description | Example |
| --- | --- | --- |
| `APP_ENV` | Deployment environment. | `production`, `staging`, `development` |
| `API_SERVER_PORT` | Port on which the API Server listens. | `3001` |
| `LOG_LEVEL` | Logging verbosity. | `info`, `debug` |
| `CSRF_HEADER_NAME` | Custom header name used for CSRF defense-in-depth. | `X-Requested-With` |

### 7.6 Secrets Management

- Variables marked **Secrets manager only** must be injected at runtime from a secrets manager (e.g., HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) and must never appear in `.env` files committed to version control or in CI/CD plaintext logs.
- A `.env.example` file with placeholder values (not real secrets) should document all required variables.
- Application startup must fail immediately with a clear error if any required secret is absent or empty.

## 8. Deployment and Network-Access Requirements

### 8.1 Network Topology

The Signals UI deployment must enforce the following network access rules:

| Component | Inbound from | Outbound to |
| --- | --- | --- |
| SPA server | Public internet (HTTPS only) | API Server (internal only) |
| API Server | SPA server (internal only) | Keycloak, Signals Backend API, Session DB |
| Session DB | API Server (internal only) | — |
| Signals Backend API | API Server (internal only) | — |
| Keycloak | API Server (server-to-server), browser (for authorization redirects) | — |

The API Server must not be accessible directly from the public internet. A network-level control (e.g., firewall rule, VPC security group, Kubernetes NetworkPolicy) must enforce this. Relying on application-layer controls alone is insufficient.

### 8.2 TLS Requirements

- All external communication (browser ↔ SPA server, browser ↔ Keycloak) must use TLS 1.2 or higher.
- All internal service-to-service communication (API Server ↔ Keycloak, API Server ↔ Signals Backend API) must use TLS unless communication occurs entirely within a trusted private network segment with equivalent security guarantees. TLS is strongly recommended regardless.
- The session database connection must use TLS if the database is not co-located on the same host.

### 8.3 Deployment Model

The specification does not mandate a specific deployment platform, but the following assumptions apply:

- The SPA and API Server may be deployed as separate services or as a single combined server process. If combined, the API Server endpoints must still be inaccessible from the public internet (enforced at the network layer).
- Horizontal scaling of the API Server is supported provided the session database is shared (i.e., no in-process session state). Sticky sessions are not required.
- The session database must be deployed with replication and automated failover appropriate to the production SLA. Point-in-time recovery (PITR) is recommended for relational deployments.
- Keycloak must be operated as a highly available cluster in production. A single Keycloak instance is acceptable for development and staging only.

### 8.4 Secrets Injection

- Secrets must be injected at runtime via the platform's secrets mechanism (e.g., Kubernetes Secrets mounted as environment variables, Vault agent sidecar, AWS Secrets Manager integration).
- Secrets must not be baked into container images or present in source-controlled configuration files.

### 8.5 Health and Readiness

The API Server must expose:

- `GET /health/live` — liveness probe. Returns `200 OK` if the process is running.
- `GET /health/ready` — readiness probe. Returns `200 OK` only if the database connection and (optionally) Keycloak connectivity are healthy. Returns `503 Service Unavailable` otherwise.

These endpoints must not require authentication and must not be proxied through the general proxy middleware.

### 8.6 Logging and Observability

- Structured JSON logging is required in production.
- Each request must be assigned a correlation ID (generated or forwarded from `X-Correlation-Id`) and logged with the request method, path, response status, and duration.
- Token values, session IDs, and client secrets must never appear in logs.
- Distributed tracing (e.g., OpenTelemetry) is recommended for tracing proxy requests end-to-end from the SPA through to the Signals Backend API.

## 9. Sequence Diagrams

### 9.1 Login Flow

&#91;embedded content: Login flow · OAuth 2.0 + PKCE · 11 steps\]

The API Server generates and stores the `state` and PKCE `code_verifier` before issuing the redirect. After callback, tokens are stored encrypted in the database; only the opaque `session_id` cookie reaches the browser.

### 9.2 Authenticated Proxy Request (Token Valid)

For a proxy request where the access token is current:

1. **Browser → API Server:** `POST /api/proxy` with session cookie and proxy request body.
2. **API Server → DB:** Look up session by session ID. Validate expiry.
3. **API Server:** Retrieve access token from session record. Check expiry — token is valid.
4. **API Server → Backend:** Forward request with `Authorization: Bearer <token>` and filtered headers.
5. **Backend → API Server:** Response (status + body).
6. **API Server → Browser:** Proxy response with backend status and permitted headers.

### 9.3 Token Renewal During Proxy Request

For a proxy request where the access token is near-expiry or expired:

1. **Browser → API Server:** `POST /api/proxy` with session cookie.
2. **API Server → DB:** Look up session. Token is near-expiry or expired.
3. **API Server:** Acquire distributed renewal lock for `session_id`.
4. **API Server → Keycloak:** `POST /token` with refresh token.
5. **Keycloak → API Server:** New access token (and optionally new refresh token).
6. **API Server → DB:** Update session with new tokens and expiry timestamps. Release lock.
7. **API Server → Backend:** Forward request with new access token.
8. **Backend → API Server:** Response.
9. **API Server → Browser:** Proxy response.

If renewal fails (step 5): session is invalidated, lock released, `401 Unauthorized` returned. Browser redirects to login.

### 9.4 Logout Flow

1. **Browser → API Server:** `POST /auth/logout` with session cookie.
2. **API Server → DB:** Delete session record.
3. **API Server → Keycloak:** Revoke refresh token and/or invoke RP-initiated logout.
4. **API Server → Browser:** `204 No Content` + `Set-Cookie` (clears session cookie).
5. **Browser:** Redirect to logged-out state or login page.

## 10. Recommended Implementation Structure and Testing Requirements

### 10.1 Auth Provider Abstraction

Keycloak is the identity provider for the initial implementation, but the authentication layer must sit behind a provider interface so that swapping to another OAuth 2.0 / OIDC provider requires no changes outside the auth module.

The interface the rest of the system depends on:

```typescript
interface AuthProvider {
  // Build the authorization URL to redirect the user to
  buildAuthorizationUrl(state: string, codeChallenge: string, redirectUri: string): string;

  // Exchange an authorization code for tokens
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenSet>;

  // Refresh an access token using a refresh token
  refreshToken(refreshToken: string): Promise<TokenSet>;

  // Revoke a token and/or perform provider-side logout
  logout(refreshToken: string | null, redirectUri: string): Promise<void | string>;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;   // single expiry — access token only
}
```

The `KeycloakAuthProvider` implements this interface. A future `GenericOAuthProvider` or any other OIDC-compatible provider implements the same interface — no changes to the proxy, session, cookie, or token encryption logic.

### 10.2 Recommended Module Structure

The API Server should be organized into the following modules:

```
api-server/
├── src/
│   ├── auth/
│   │   ├── login.ts         # Initiates Keycloak flow, generates state + PKCE
│   │   ├── callback.ts      # Handles Keycloak callback, exchanges code, creates session
│   │   ├── logout.ts        # Invalidates session, revokes token, clears cookie
│   │   └── session.ts       # Session lookup, validation, and cookie management
│   ├── proxy/
│   │   ├── middleware.ts    # Session validation middleware for all proxy requests
│   │   ├── validator.ts     # Request schema validation (method, path, headers)
│   │   ├── registry.ts      # Allowed backend operation registry + path resolution
│   │   ├── forwarder.ts     # Constructs and executes the outbound backend request
│   │   └── response.ts      # Filters and formats backend responses
│   ├── token/
│   │   ├── renewal.ts       # Token refresh logic with distributed locking
│   │   └── encryption.ts    # Token encrypt/decrypt using AES-256-GCM
│   ├── db/
│   │   ├── sessions.ts      # CRUD operations for the sessions table
│   │   └── pending.ts       # CRUD operations for pending_logins table
│   ├── config/
│   │   └── index.ts         # Loads and validates all environment variables at startup
│   ├── middleware/
│   │   ├── csrf.ts          # CSRF defense-in-depth (custom header check)
│   │   └── correlationId.ts # Assigns/forwards X-Correlation-Id
│   └── health/
│       └── index.ts         # /health/live and /health/ready endpoints
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 10.2 Open Design Decisions

The following decisions must be resolved before implementation begins:

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| 1 | Proxy response status code | Wrap all backend responses in `200 OK` vs. propagate backend status directly | Propagate backend status directly for simplicity; SPA differentiates proxy errors (401, 403, 502) from backend errors (4xx/5xx). |
| 2 | Session store technology | PostgreSQL vs. Redis | PostgreSQL if audit/history is required; Redis for high-throughput deployments. |
| 3 | SameSite cookie policy | `Lax` vs. `Strict` | `Lax` unless the application has no legitimate cross-site navigation entry points. |
| 4 | RP-initiated logout | Full front-channel vs. server-side revocation only | Depends on Keycloak configuration and whether SSO logout propagation is required. |
| 5 | Per-operation authorization | Session-level only vs. role/claim checks per proxied path | Confirm whether Keycloak claims must be enforced at the proxy layer or delegated to the backend. |
| 6 | Retry on non-idempotent methods | No retry vs. retry with idempotency key | Confirm whether the Signals Backend API supports idempotency keys. |

### 10.3 Assumptions

- Keycloak supports the Authorization Code flow with PKCE and issues refresh tokens when `offline_access` scope is requested.
- The Signals Backend API accepts `Authorization: Bearer <token>` and does not require any client certificate or additional credentials from the API Server.
- The deployment environment provides a secrets manager compatible with runtime secret injection.
- The existing Signals application infrastructure includes a shared database or caching layer suitable for session storage.

### 10.4 Testing Requirements

**Unit tests** (per module):

- Auth: valid and invalid `state` parameter; PKCE verifier mismatch; Keycloak exchange failure; session creation; cookie attributes.
- Proxy validator: valid and invalid methods; paths in and out of registry; blocked headers; payload filtering.
- Token renewal: near-expiry detection; successful renewal; refresh token failure; concurrent renewal lock behavior (mock lock contention).
- Token encryption: encrypt → decrypt roundtrip; tampered ciphertext rejection.
- Config: startup failure on missing required variables.

**Integration tests:**

- Full login → proxy request → logout flow against a Keycloak test realm.
- Token renewal triggered mid-proxy-request.
- Concurrent proxy requests triggering a single renewal (lock contention).
- Session expiry: request after session absolute expiry returns `401`.
- SSRF attempt: proxy request with a path not in the registry returns `403`.
- Header injection: blocked headers stripped; `Authorization` override rejected.

**End-to-end tests:**

- Browser-based test (e.g., Playwright) covering: unauthenticated access → redirect to login → Keycloak login → return to SPA → authenticated API call → logout → unauthenticated redirect.
- Verify session cookie attributes (HttpOnly, Secure, SameSite) via browser DevTools or test assertions.

**Security review checklist:**

- [ ] No token or session ID appears in any log output.
- [ ] Session cookie is HttpOnly and Secure in all non-development environments.
- [ ] PKCE is enforced (verify that requests without `code_verifier` are rejected by Keycloak).
- [ ] Proxy registry cannot be bypassed by path traversal or URL encoding.
- [ ] Concurrent token renewal produces exactly one Keycloak call per session under load.
- [ ] All environment variable requirements are documented and enforced at startup.

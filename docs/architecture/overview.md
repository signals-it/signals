# Signals architecture

Signals is split into a React SPA, a **proxy API** (UI authentication + proxy), and a **backend API** (platform data). The SPA talks only to the proxy API. The backend API is internal and reachable only by the proxy.

## Proxy API (`apps/proxy-api`)

Login redirects from the proxy to Keycloak, then back to a checked callback. The proxy uses its confidential client credential and PKCE verifier, exchanges the code for tokens, stores them encrypted in PostgreSQL, and issues an opaque browser session cookie. The SPA reads the user, allowed tenants and CSRF token from `/api/session`.

Every request receives a correlation ID (forwarded `X-Correlation-Id` or generated) echoed in the response. Liveness (`GET /health/live`) and readiness (`GET /health/ready`, checks PostgreSQL and OIDC discovery) probes are unauthenticated and excluded from the proxy/auth middleware.

Downstream backend calls are centralized through `POST /api/proxy`. The SPA and adapters never hold tokens. The proxy validates the request schema, enforces a method allowlist, resolves the target path against a registered operation registry (never an arbitrary URL, with traversal and encoded-separator rejection), injects `Authorization: Bearer <access token>`, adds the internal session reference and shared secret, filters request/response headers against explicit allowlists, and returns the backend status wrapped in `{ status, body, headers }`. Authentication sits behind an `AuthProvider` interface (`apps/proxy-api/src/auth/provider.ts`) implemented by `KeycloakAuthProvider`, so another OIDC provider can replace it without touching session, cookie, token-encryption or proxy logic.

## Backend API (`apps/api`)

The Signals backend API owns platform data (tenants, memberships, integration metadata), the database migrations (`database/migrations/`) and the trusted membership CLI. It is deployed independently and exposed only on the internal network.

Requests must carry the shared `X-Signals-Internal-Token` (proving they came from the proxy) and the opaque `X-Signals-Session` reference. The backend re-validates the session against the shared session tables and re-checks active user, tenant and role before serving a response. It never trusts a browser origin directly.

## Data and products

GLPI, Zabbix and Keycloak keep separate schemas and release cycles. Product folders are integration/customization boundaries, not copied upstream source. GLPI remains MariaDB-backed; Zabbix and Keycloak use separate PostgreSQL databases. The Signals platform database owns tenants, memberships, connections, audit events and sessions.

## Implemented endpoints

| Endpoint | Service | Access |
|---|---|---|
| GET /api/health | Proxy API | Public liveness |
| GET /auth/login | Proxy API | Public, throttled OIDC start |
| GET /auth/callback | Proxy API | Single-use state/nonce/PKCE login transaction |
| GET /api/session | Proxy API | Active server session |
| POST /api/logout | Proxy API | Active session + Origin + CSRF |
| POST /api/proxy | Proxy API | Active session + Origin + CSRF + method/path/header allowlists |
| GET /health/live, /health/ready | Proxy API | Public probes |
| GET /signals/api/v1/health | Backend API | Proxy shared secret |
| GET /signals/api/v1/tenants/:tenantId/integrations | Backend API | Proxy secret + active session + integrations:read |
| GET /signals/api/v1/tenants/:tenantId/administration | Backend API | Proxy secret + active session + administration:read |
| GET /health/live, /health/ready | Backend API | Public probes (internal network) |

## Deployment topology

The SPA and proxy API run in a single pod (nginx serving the SPA and reverse-proxying `/api`/`/auth` to the proxy container over the pod network). The backend API is a separate Deployment with an internal-only Service. See `deploy/k8s/signals.yaml`.

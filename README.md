# Signals

React + TypeScript / Node.js + TypeScript monorepo. The Signals platform is split into three independently runnable applications:

| App | Role | Talks to |
|---|---|---|
| `apps/web` | React single-page application | Proxy API only |
| `apps/proxy-api` | UI authentication (Keycloak/OIDC), sessions, server-side token storage and renewal, authenticated proxy | Keycloak, platform database, backend API (internal) |
| `apps/api` | Signals backend API: platform data, membership administration, migrations | Platform database |

The SPA never sees tokens, cookies are opaque and `HttpOnly`, and the backend API is never reachable from the browser. The proxy API forwards only registered, allowlisted operations to the backend API over internal networking.

## Architecture

```
Browser ──HTTPS──> SPA (nginx) ──/api,/auth──> Proxy API ──internal──> Backend API
                                                    │                        │
                                                    ├──> Keycloak (OIDC)     └──> Platform DB
                                                    └──> Platform DB (sessions, encrypted tokens)
```

- **Keycloak OIDC** — Authorization Code + S256 PKCE, single-use state/nonce login transactions. Confidential client; the client secret never leaves the proxy API.
- **Sessions and tokens** — tokens are encrypted at rest (AES-256-GCM) in PostgreSQL. The browser receives only an opaque `HttpOnly`/`SameSite=Lax` cookie (`__Host-` prefixed in production). Refresh-token rotation is serialized with a database row lock.
- **Authenticated proxy** (`POST /api/proxy`) — the SPA sends `{ method, path, queryParams, payload, headers }`. The proxy validates the schema, enforces a method allowlist, resolves `path` against a registered operation registry (never an arbitrary URL; traversal and encoded separators are rejected), injects `Authorization: Bearer <access token>`, adds the internal session reference, and returns `{ status, body, headers }`.
- **Backend authorization** — the backend API is internal only. It accepts requests solely from the proxy, proven by a shared secret (`BACKEND_INTERNAL_TOKEN`), and re-validates the forwarded session against the shared database plus tenant membership and role (`tenant_admin`, `operator`, `viewer`).
- **Provider boundary** — authentication sits behind an `AuthProvider` interface (`apps/proxy-api/src/auth/provider.ts`), implemented by `KeycloakAuthProvider`. Another OIDC provider can replace it without touching session, cookie, token-encryption or proxy code.

### Network access

| Component | Inbound from | Outbound to |
|---|---|---|
| SPA | Public internet (HTTPS) | Proxy API (localhost in the pod) |
| Proxy API | SPA server (internal) | Keycloak, backend API, platform DB |
| Backend API | Proxy API (internal only) | Platform DB |
| Platform DB | Proxy API, backend API | — |

The SPA and proxy API are independently runnable in development and are deployed together in a single pod (two containers sharing a network namespace). The backend API is a separate Deployment reachable through the internal `signals-api` Service. See `deploy/k8s/signals.yaml`.

## Start locally

Requires Node.js 22.12+ (Node 24 recommended), Git, Docker Desktop with Compose v2.

```bash
npm ci
npm run setup:local
docker compose --env-file .env up -d platform-db keycloak
# Wait until Keycloak is ready at http://localhost:8080
npm run db:migrate
npm run dev:api      # backend API (http://127.0.0.1:4100)
# In separate terminals, from the same repo root:
npm run dev:proxy    # proxy API (http://127.0.0.1:4000)
npm run dev:web      # React SPA (http://localhost:5173)
```

Open **http://localhost:5173** and choose **Sign in with your organization**.

Keycloak starts with the Signals realm and a confidential client. No demo user/password ships. In the Keycloak console at http://localhost:8080, sign in with the local administrator credentials from `.env`, select **Signals**, create a user, and set a password in Credentials (temporary=false for evaluation). Log into Signals once; the no-access page displays your Keycloak subject. An administrator grants the initial membership:

```bash
npm run user:grant -- YOUR_KEYCLOAK_SUBJECT signals-demo tenant_admin
```

Click **Check access again**. Never grant membership from a browser request or infer it from an email domain. The CLI is for a trusted administrator with database access.

## Repository layout

| Folder | Purpose |
|---|---|
| `apps/web/` | React SPA: shell, login entry, navigation |
| `apps/proxy-api/` | OIDC login, sessions, token storage/renewal, authenticated proxy |
| `apps/api/` | Signals backend API: platform endpoints, migrations, membership CLI |
| `modules/<module>/ui/` | React screens imported by `apps/web` |
| `integrations/<product>-adapter/` | Backend adapter boundaries (GLPI, Zabbix, Keycloak) |
| `products/` | Product deployment/customization boundaries; Keycloak realm template |
| `database/migrations/` | Platform tables and auth/session schema |
| `deploy/compose/` | Local identity/database stack; optional products profile |
| `deploy/k8s/` | Reference pod (SPA + proxy) and backend deployment |
| `scripts/` | Safe local configuration generation |
| `docs/` | Setup, architecture, security and enterprise SSO guides |

## Configuration

All configuration is environment based. `npm run setup:local` generates `.env` from `.env.example` with random secrets. Never commit `.env`.

**Proxy API (`apps/proxy-api`)**

| Variable | Description |
|---|---|
| `API_HOST`, `API_PORT` | Bind address/port for the proxy API (`127.0.0.1:4000` locally) |
| `APP_ORIGIN`, `OIDC_CALLBACK_URL` | Public SPA origin and exact Keycloak callback |
| `OIDC_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | Confidential OIDC client |
| `SESSION_ENCRYPTION_KEY` | Base64 AES-256 key for encrypting tokens at rest |
| `CSRF_HEADER_NAME`, `SESSION_IDLE_EXPIRY_SECONDS`, `SESSION_ABSOLUTE_EXPIRY_SECONDS`, `TOKEN_RENEWAL_THRESHOLD_SECONDS` | Session/CSRF controls |
| `SIGNALS_BACKEND_BASE_URL` | Backend API base URL (internal) |
| `BACKEND_INTERNAL_TOKEN` | Shared secret proving proxy origin to the backend |
| `PROXY_BACKEND_TIMEOUT_MS`, `PROXY_ALLOWED_METHODS`, `PROXY_ALLOWED_REQUEST_HEADERS`, `PROXY_ALLOWED_RESPONSE_HEADERS`, `PROXY_REGISTRY_PATH` | Proxy controls (see `apps/proxy-api/proxy-registry.example.json`) |

**Backend API (`apps/api`)**

| Variable | Description |
|---|---|
| `BACKEND_API_HOST`, `BACKEND_API_PORT` | Bind address/port (`127.0.0.1:4100` locally; `0.0.0.0` in a container) |
| `BACKEND_INTERNAL_TOKEN` | Same shared secret as the proxy; requests without it are rejected |
| `PLATFORM_DATABASE_URL` | Shared platform database |

### Authenticated proxy

```json
{ "method": "GET", "path": "/signals/api/v1/tenants/<tenant-id>/integrations" }
```

Errors: `400` malformed/blocked method, `403` path or blocked header, `401` session, `408` backend timeout, `502` backend unreachable. Blocked headers (`Authorization`, `Cookie`, `Host`, `X-Signals-Session`, `X-Signals-Internal-Token`, ...) are rejected; unknown headers are dropped; only allowlisted response headers are returned.

## Deployment

Build one image per app from the repository root:

```bash
docker build -f apps/web/Dockerfile       -t signals-web:0.1.0       .
docker build -f apps/proxy-api/Dockerfile -t signals-proxy-api:0.1.0 .
docker build -f apps/api/Dockerfile       -t signals-api:0.1.0       .
```

`deploy/k8s/signals.yaml` deploys the SPA and proxy API together in one pod and the backend API as an independent Deployment. Set `SIGNALS_BACKEND_BASE_URL` to the internal backend Service (`http://signals-api:4100`), keep `SESSION_ENCRYPTION_KEY` and `BACKEND_INTERNAL_TOKEN` identical across replicas, and inject all secrets from a secrets manager. The backend API Service has no Ingress.

For Azure/enterprise routing and security guidance see `docs/security/baseline.md` and `docs/security/enterprise-sso.md`.

## Scope and validation

The authenticated portal is a working starter. Asset, ticketing, monitoring and orchestration workflows remain roadmap screens; GLPI/Zabbix API adapters remain placeholders. Enterprise providers require organization-specific Keycloak configuration; native tool SSO is not implemented.

```bash
npm run typecheck
npm run build
npm test
```

Tests run real SQL through embedded PostgreSQL (PGlite). The proxy API suite covers OIDC callback/PKCE/state/nonce with a mock identity provider, session lifecycle, token refresh, CSRF/Origin, and the proxy (validation, registry, traversal/SSRF rejection, header filtering, retry). The backend API suite covers the proxy shared-secret boundary, session validation from the shared DB, and tenant membership/role enforcement. Database migrations are exercised by both suites. Docker/real Keycloak end-to-end execution is not available in the delivery environment; follow the manual smoke checklist in `docs/testing.md`.

See [local setup](docs/setup/local-development.md), [architecture](docs/architecture/overview.md), [security](docs/security/baseline.md), [enterprise SSO](docs/security/enterprise-sso.md), and [testing](docs/testing.md).

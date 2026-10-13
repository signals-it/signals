# Signals

React + TypeScript / Node.js + TypeScript monorepo with working Keycloak OIDC login and PostgreSQL session persistence. Based on the finalized Unified IT starter layout.

## Start locally

Requires Node.js 22.12+ (Node 24 recommended), Git, Docker Desktop with Compose v2.

```bash
npm ci
npm run setup:local
docker compose --env-file .env up -d platform-db keycloak
# Wait until Keycloak is ready at http://localhost:8080
npm run db:migrate
npm run dev:api
# In another terminal, from the same repo root:
npm run dev:web
```

Open **http://localhost:5173**. Use **Sign in with your organization**.

Keycloak starts with the Signals realm and confidential BFF client. No demo user/password is shipped. In the Keycloak console at http://localhost:8080, sign in using the local administrator credentials from `.env`, select **Signals**, create a user, and set a password in Credentials (temporary=false for evaluation). Log into Signals once. The no-access page displays your Keycloak subject; an administrator grants the initial membership:

```bash
npm run user:grant -- YOUR_KEYCLOAK_SUBJECT signals-demo tenant_admin
```

Click **Check access again**. Never grant membership from a browser request or infer it from an email domain. The CLI is for a trusted administrator with database access.

## Finalized folder structure

| Folder | Purpose |
|---|---|
| `apps/web/` | React application shell, login entry, navigation |
| `apps/api/` | Node BFF, OIDC callback, session middleware, protected REST API |
| `modules/itsm/` | Future GLPI ticketing React screens |
| `modules/assets/` | Future GLPI inventory React screens |
| `modules/monitoring/` | Future Zabbix React screens |
| `modules/orchestration/` | Future platform automation React screens |
| `modules/administration/ui/` | Implemented user and tenant session controls |
| `integrations/glpi-adapter/` | GLPI backend adapter scaffold |
| `integrations/zabbix-adapter/` | Zabbix backend adapter scaffold |
| `integrations/keycloak-adapter/` | Identity boundary documentation; executable BFF is in `apps/api/src/` |
| `products/glpi/`, `products/zabbix/` | Product deployment/customization boundaries |
| `products/keycloak/realm/` | Realm template and generated local realm import |
| `database/migrations/` | Platform tables and auth/session schema |
| `deploy/compose/` | Local identity/database stack; optional products profile |
| `scripts/` | Safe local configuration generation |
| `docs/` | Setup, architecture, security and enterprise SSO guide |

New product screens belong in `modules/<module>/ui/`; import them into `apps/web`. Backend product API calls belong in `integrations/<product>-adapter/`. Retain native GLPI and Zabbix backends and their independent databases. This package includes product folders and deployment definitions, not full upstream source copies.

## Implemented login

- Confidential Keycloak client, Authorization Code + S256 PKCE, state and nonce checks using `openid-client`.
- Tokens stay in AES-256-GCM encrypted PostgreSQL records. Browser receives an opaque HttpOnly / SameSite=Lax cookie (Secure with `__Host-` prefix in production).
- Single-use five-minute login transactions; session ID rotation at login.
- 30-minute sliding idle expiry, eight-hour maximum lifetime, refresh token rotation serialized by a database row lock.
- Logout deletes the local session before returning Keycloak's end-session URL.
- Same-origin API through Vite proxy; mutating requests require exact Origin and logout additionally requires CSRF token.
- Explicit database tenant memberships and tenant-scoped roles: tenant_admin, operator, viewer. Membership and active account/tenant checks run on protected requests.
- Login audit events and bounded login request rate.

## Scope and validation

The authenticated portal is a working starter. Asset, ticketing, monitoring and orchestration workflows remain roadmap screens. GLPI/Zabbix API adapters remain placeholders. Enterprise providers require your organization-specific Keycloak configuration; native tool SSO is separate and is not yet implemented.

```bash
npm run typecheck
npm run build
npm test
```

Tests exercise OIDC callback/PKCE/state/nonce with a mock identity provider and SQL behavior using embedded PostgreSQL (PGlite). Docker/real Keycloak end-to-end execution was not possible in the delivery environment. Follow the manual smoke checklist before deploying.

See [local setup](docs/setup/local-development.md), [enterprise SSO](docs/security/enterprise-sso.md), [security](docs/security/baseline.md), [architecture](docs/architecture/overview.md), and [validation](docs/testing.md).

## Initialize your GitHub repository

Create an empty private GitHub repository named `signals`, extract this package, and run:

```bash
git init -b main
git add .
git commit -m "Initialize Signals with Keycloak BFF login"
git remote add origin https://github.com/YOUR_ORGANIZATION/signals.git
git push -u origin main
```

The generated `.env` and realm secret export are ignored. Upstream product licenses remain their own; select the Signals code license before external distribution.

# Validation

Delivery checks (run from the repository root):

- `npm run typecheck`: SPA, backend API and proxy API TypeScript checks.
- `npm run build`: production SPA bundle, backend API and proxy API compilation.
- `npm test`: backend API suite then proxy API suite.

Proxy API tests run real SQL through PGlite with a mock OIDC provider, PKCE verification, signed ID tokens and HTTP requests. Coverage includes state/nonce rejection, callback single use, encrypted persistence, membership provisioning boundary, membership listing, disabled user, idle/absolute expiry, refresh rotation, Origin/CSRF checks, logout, and the proxy (path normalization/traversal rejection, registry matching and target resolution, method/header/payload validation, blocked-header rejection, response-header filtering, injected bearer token, backend status forwarding, idempotent retry, timeout).

Backend API tests exercise the proxy shared-secret boundary, session validation against the shared session DB, tenant membership and role enforcement, suspended tenant, revoked membership, disabled user, and public health probes. Database migrations are applied by both suites.

Compose YAML parsing and local configuration generation are checked.

The test database executes PostgreSQL SQL but does not model distributed concurrency or a production network database. Docker was not available in the delivery environment, so the Compose stack, the container images and a browser login against real Keycloak have not been run.

## Manual smoke checklist

1. Start the stack using the root README (backend API, proxy API, SPA, Keycloak, PostgreSQL). Confirm a Signals realm and `signals-bff` client exist.
2. Create a Keycloak test user, log in from Signals, confirm the no-access page.
3. Grant viewer membership with the CLI and reload; confirm integrations visible and administration returns 403.
4. Grant tenant_admin, reload, confirm administration access. Switch between two explicitly granted tenants.
5. Log out; replay the old session cookie and confirm 401. Start login again and confirm IdP logout behavior.
6. Remove membership or disable the Signals user in PostgreSQL and confirm protected requests fail.
7. Wait past access-token expiry, use the API and confirm refresh. Expire idle/absolute session and confirm login required.
8. Call the backend API directly (bypassing the proxy) and confirm it returns 401 without `X-Signals-Internal-Token`.
9. Confirm `POST /api/proxy` forwards an allowlisted call with the session's bearer token and rejects an unregistered path (403), a blocked header (403) and a disallowed method (400).
10. Test production HTTPS, reverse-proxy topology, multiple replicas, database TLS and session-key/internal-token consistency before deployment.

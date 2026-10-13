# Validation

Delivery checks:

- `npm run typecheck`: React and API TypeScript checks.
- `npm run build`: production React bundle and API compilation.
- `npm test`: real SQL executed through PGlite with a mock OIDC provider, PKCE verification, signed ID tokens and HTTP API requests. Tests include state/nonce rejection, callback single use, encrypted persistence, membership provisioning boundary, tenant/role rejection, membership revocation, disabled user, tenant suspension, idle/absolute expiry, refresh rotation, Origin/CSRF checks and logout.
- Compose YAML parsing and local configuration generation were checked.

The test database executes PostgreSQL SQL but does not model distributed concurrency or a production network database. Docker was not installed in the delivery environment, so the actual Compose stack and browser login against Keycloak have not been run.

Manual smoke checklist:

1. Start the stack using the root README. Confirm a Signals realm and signals-bff client exist.
2. Create a Keycloak test user, log in from Signals, confirm a no-access page.
3. Grant viewer membership with the CLI and reload; confirm integrations visible but administration API returns 403.
4. Grant tenant_admin, reload, confirm administration access. Switch between two explicitly granted tenants.
5. Log out; replay the old session cookie and confirm 401. Start login again and confirm IdP logout behavior.
6. Remove membership or disable the Signals user in PostgreSQL and confirm protected requests fail.
7. Wait past access-token expiry, use the API and confirm refresh. Expire idle/absolute session and confirm login required.
8. Configure one actual enterprise provider and confirm account linking, MFA and user revocation policy.
9. Test production HTTPS, reverse-proxy topology, multiple replicas, database TLS and session-key consistency before deployment.

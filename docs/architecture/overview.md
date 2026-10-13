# Signals architecture

React uses a same-origin Node BFF. Login redirects from the BFF to Keycloak, then back to a checked callback. The BFF exchanges the code using its confidential client credential and PKCE verifier, stores encrypted tokens in PostgreSQL and issues an opaque browser session cookie. React reads the user, allowed tenants and CSRF token from `/api/session`.

Each tenant-scoped request rechecks active user and tenant membership in PostgreSQL. Roles are application-managed; they are not inferred from unverified JWT contents or caller headers. New React product screens live in `modules/<module>/ui/`, imported by `apps/web`. Backend adapters live in `integrations/` and must use the validated tenant context.

GLPI, Zabbix and Keycloak keep separate schemas and release cycles. Product folders are integration/customization boundaries, not copied upstream source. GLPI remains MariaDB-backed; Zabbix and Keycloak use separate PostgreSQL databases. Signals database owns tenants, memberships, connections, audit events and sessions.

Implemented endpoints:

| Endpoint | Access |
|---|---|
| GET /api/health | Public liveness |
| GET /auth/login | Public, throttled OIDC start |
| GET /auth/callback | Single-use state/nonce/PKCE login transaction |
| GET /api/session | Active server session |
| POST /api/logout | Active session + Origin + CSRF |
| GET /api/tenants/:tenantId/integrations | Active tenant membership + integrations:read |
| GET /api/tenants/:tenantId/administration | Active tenant membership + administration:read |

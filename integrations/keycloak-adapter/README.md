# Keycloak identity boundary

Executable login/session code lives in `apps/api/src/app.ts`, `security.ts`, `config.ts` and `db.ts`. Keycloak realm provisioning lives in `products/keycloak/realm/`. This folder reserves the boundary for future enterprise provider provisioning or Keycloak administration adapters; do not move OIDC tokens into React.

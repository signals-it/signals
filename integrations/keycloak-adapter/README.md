# Keycloak identity boundary

Executable login/session/proxy code lives in `apps/proxy-api/src/`. The backend API in `apps/api/` never handles OIDC tokens. Keycloak realm provisioning lives in `products/keycloak/realm/`. This folder reserves the boundary for future enterprise provider provisioning or Keycloak administration adapters; do not move OIDC tokens into React.

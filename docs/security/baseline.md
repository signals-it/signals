# Security baseline and Azure deployment

Use a single public HTTPS origin: route `/auth/*` and `/api/*` to the proxy API and all other paths to the built React app. Never route traffic to the backend API from the public origin; it is internal only and reachable exclusively by the proxy (enforced by network policy plus the shared `BACKEND_INTERNAL_TOKEN`). Azure Front Door/Application Gateway or a suitable App Service reverse proxy can provide this routing. Vite is only a local development server.

Set NODE_ENV=production, APP_ORIGIN=https://signals.example.com, OIDC_CALLBACK_URL=https://signals.example.com/auth/callback, OIDC_ISSUER to the trusted HTTPS Keycloak realm. Configure the exact callback and post-logout redirect in the Keycloak client. Run Keycloak with production `start`, persistent storage and a configured public hostname; never deploy this Compose `start-dev` setup to production.

Both Node APIs bind to loopback for local development. For containers, set `API_HOST` and `BACKEND_API_HOST` to `0.0.0.0` and restrict ingress to the intended peer only (proxy API from the SPA server; backend API from the proxy API). The backend API additionally rejects requests without the shared `BACKEND_INTERNAL_TOKEN`. `trust proxy=1` assumes exactly one trusted proxy hop; adjust to your actual trusted proxy network. Do not expose a proxy-trusting API directly to untrusted clients.

Store database credentials, client secret, SESSION_ENCRYPTION_KEY and BACKEND_INTERNAL_TOKEN in Azure Key Vault / protected application settings. Keep the same encryption key and internal token across the proxy and backend replicas; the backend rejects any request without the internal token. Restrict PostgreSQL network access, use TLS with a verified server certificate, migrations via a deployment identity, and a least-privilege runtime database user. Do not disable TLS verification.

Sessions have a 30-minute idle timeout and eight-hour absolute timeout. The configured realm also has those limits. Keycloak revocation is observed on the next refresh (up to the five-minute access-token lifetime); immediate cross-application logout/backchannel logout is not implemented. Local logout is immediate; if the IdP is unavailable its session may remain active. Reauthentication then depends on the IdP policy.

Database sessions encrypt tokens at rest and store only hashed opaque cookie IDs. The encryption key protects those records; compromise of the running API or its key compromises sessions. Plan encryption-key rotation and deletion of affected sessions. Avoid logging cookies, token endpoint responses, secrets or callback URLs.

The rate limiter is per-process. Use a shared store or edge throttling for multiple replicas. SQL tenant membership checks protect the implemented tenant endpoints. Row-level security is not enabled; every future tenant data query and adapter must receive and constrain the validated tenant ID. Roles fail closed when unknown. The browser's hidden administration navigation is only presentation; the API permission check is authoritative.

For production add backchannel logout, centralized security monitoring, audited membership administration, MFA policy, secret rotation, dependency scanning and actual Keycloak/PostgreSQL browser tests. This is a development starter, not a production certification.

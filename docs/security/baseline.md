# Security baseline and Azure deployment

Use a single public HTTPS origin: route `/auth/*` and `/api/*` to the Node API and all other paths to the built React app. Azure Front Door/Application Gateway or a suitable App Service reverse proxy can provide this routing. Vite is only a local development server.

Set NODE_ENV=production, APP_ORIGIN=https://signals.example.com, OIDC_CALLBACK_URL=https://signals.example.com/auth/callback, OIDC_ISSUER to the trusted HTTPS Keycloak realm. Configure the exact callback and post-logout redirect in the Keycloak client. Run Keycloak with production `start`, persistent storage and a configured public hostname; never deploy this Compose `start-dev` setup to production.

The API currently binds to loopback for local development. For a separate Azure container, deliberately change the bind address and restrict ingress to your reverse proxy. `trust proxy=1` assumes exactly one trusted proxy hop; adjust to your actual trusted proxy network. Do not expose a proxy-trusting API directly to untrusted clients.

Store database credentials, client secret and SESSION_ENCRYPTION_KEY in Azure Key Vault / protected application settings. Keep the same encryption key across API replicas. Restrict PostgreSQL network access, use TLS with a verified server certificate, migrations via a deployment identity, and a least-privilege runtime database user. Do not disable TLS verification.

Sessions have a 30-minute idle timeout and eight-hour absolute timeout. The configured realm also has those limits. Keycloak revocation is observed on the next refresh (up to the five-minute access-token lifetime); immediate cross-application logout/backchannel logout is not implemented. Local logout is immediate; if the IdP is unavailable its session may remain active. Reauthentication then depends on the IdP policy.

Database sessions encrypt tokens at rest and store only hashed opaque cookie IDs. The encryption key protects those records; compromise of the running API or its key compromises sessions. Plan encryption-key rotation and deletion of affected sessions. Avoid logging cookies, token endpoint responses, secrets or callback URLs.

The rate limiter is per-process. Use a shared store or edge throttling for multiple replicas. SQL tenant membership checks protect the implemented tenant endpoints. Row-level security is not enabled; every future tenant data query and adapter must receive and constrain the validated tenant ID. Roles fail closed when unknown. The browser's hidden administration navigation is only presentation; the API permission check is authoritative.

For production add backchannel logout, centralized security monitoring, audited membership administration, MFA policy, secret rotation, dependency scanning and actual Keycloak/PostgreSQL browser tests. This is a development starter, not a production certification.

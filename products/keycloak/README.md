# Keycloak

The checked-in `realm/signals-realm.template.json` is secret-free. `npm run setup:local` generates `realm/signals-realm.json` with a random confidential-client secret also placed in `.env`. Both generated files are Git-ignored. Compose imports the Signals realm on first start. No demo user is included. Create a test user in the console, then grant its Signals membership as described in the root README.

Production requires HTTPS, a production Keycloak startup command, exact production redirect URLs, secret management and customer provider configuration. See `docs/security/enterprise-sso.md`.

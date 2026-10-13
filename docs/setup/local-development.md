# Local setup

Follow the commands in the root README in order. Run all npm commands from the repository root. The API resolves `.env` relative to its code, not to the shell working directory. PostgreSQL migrations must run before login.

`npm run setup:local` creates a random client secret and a random 32-byte encryption key, writes `.env`, and creates the Keycloak realm import. It refuses to overwrite existing configuration. Preserve the key: changing it invalidates existing encrypted sessions and login transactions.

Keycloak imports the realm only on the first startup of a new realm. Changing an import file does not update a realm already stored in its database. Change the existing client in the Keycloak console and keep its secret consistent with `.env`. For a fresh local install, remove only an explicitly disposable local Keycloak database volume; this deletes users and configuration.

Local identity services:

- React: http://localhost:5173
- API (loopback): http://localhost:4000/api/health
- Keycloak: http://localhost:8080
- PostgreSQL: localhost:5432

Use `localhost` consistently, not a mix of `localhost` and `127.0.0.1` in browser URLs. Callback and logout URLs are exact matches. Missing membership after login is expected until a trusted admin grants access using the CLI.

Optional product evaluation:

```bash
docker compose --env-file .env --profile products up -d
```

GLPI is at http://localhost:8081 and Zabbix at http://localhost:8082. Their first-run setup, product credentials and API permissions are separate. Product image entries were inherited from the starter and have not been runtime-tested here; pin and verify them before team deployment.

## Troubleshooting

- Connection refused: start Docker services; check `docker compose logs keycloak platform-db`.
- Missing table: run `npm run db:migrate`.
- Invalid client: client secret in Keycloak must equal `.env`.
- Invalid redirect URI: use http://localhost:5173/auth/callback in the client and `.env`.
- Missing/expired transaction: start login again; do not reuse a callback URL.
- User needs tenant access: log in once, grant membership using Keycloak subject, reload.
- After modifying `.env`, restart the Node API.

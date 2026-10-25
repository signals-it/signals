# Local setup

Follow the commands in the root README in order. Run all npm commands from the repository root. Each app resolves `.env` relative to its code, not to the shell working directory. PostgreSQL migrations must run before login.

`npm run setup:local` creates random client/session/internal secrets, writes `.env`, and creates the Keycloak realm import. It refuses to overwrite existing configuration. Preserve `SESSION_ENCRYPTION_KEY`: changing it invalidates existing encrypted sessions and login transactions. Preserve `BACKEND_INTERNAL_TOKEN`: the proxy and backend must share the same value.

Keycloak imports the realm only on the first startup of a new realm. Changing an import file does not update a realm already stored in its database. Change the existing client in the Keycloak console and keep its secret consistent with `.env`. For a fresh local install, remove only an explicitly disposable local Keycloak database volume; this deletes users and configuration.

## Services

Three Node processes plus the local identity stack:

- React SPA: http://localhost:5173 (`npm run dev:web`)
- Proxy API (loopback): http://127.0.0.1:4000 (`npm run dev:proxy`)
- Backend API (loopback): http://127.0.0.1:4100 (`npm run dev:api`)
- Keycloak: http://localhost:8080
- PostgreSQL: localhost:5432

Vite proxies `/api` and `/auth` from the SPA to the proxy API. The proxy API reaches the backend API through `SIGNALS_BACKEND_BASE_URL` (defaults to `http://127.0.0.1:4100`). The backend API must never be started without the proxy sharing `BACKEND_INTERNAL_TOKEN`.

Use `localhost` consistently, not a mix of `localhost` and `127.0.0.1`, in browser URLs. Callback and logout URLs are exact matches. Missing membership after login is expected until a trusted admin grants access using the CLI (`npm run user:grant`).

## Optional product evaluation

```bash
docker compose --env-file .env --profile products up -d
```

GLPI is at http://localhost:8081 and Zabbix at http://localhost:8082. Their first-run setup, product credentials and API permissions are separate. Product image entries were inherited from the starter and have not been runtime-tested here; pin and verify them before team deployment.

## Troubleshooting

- Connection refused: start Docker services; check `docker compose logs keycloak platform-db`.
- Missing table: run `npm run db:migrate` (runs from the backend API package).
- Invalid client: client secret in Keycloak must equal `.env`.
- Invalid redirect URI: use http://localhost:5173/auth/callback in the client and `.env`.
- Missing/expired transaction: start login again; do not reuse a callback URL.
- Backend returns 401: ensure `BACKEND_INTERNAL_TOKEN` is identical for the proxy and backend, and start the backend.
- Backend unreachable (502 from `/api/proxy`): confirm `SIGNALS_BACKEND_BASE_URL` and that the backend API is listening on port 4100.
- User needs tenant access: log in once, grant membership using the Keycloak subject, reload.
- After modifying `.env`, restart the affected Node processes.

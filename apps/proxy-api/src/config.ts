import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
export const production = process.env.NODE_ENV === 'production';
function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}; run npm run setup:local first`);
  return v;
}
function optionalNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
function optionalList(name: string, fallback: string[]) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}
export const settings = {
  database: required('PLATFORM_DATABASE_URL'),
  key: Buffer.from(required('SESSION_ENCRYPTION_KEY'), 'base64'),
  issuer: required('OIDC_ISSUER'),
  clientId: process.env.KEYCLOAK_CLIENT_ID ?? 'signals-bff',
  clientSecret: required('KEYCLOAK_CLIENT_SECRET'),
  origin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  callback: process.env.OIDC_CALLBACK_URL ?? 'http://localhost:5173/auth/callback',
  host: process.env.API_HOST ?? '127.0.0.1',
  port: Number(process.env.API_PORT ?? 4000),
  cookie: production ? '__Host-signals_session' : 'signals_session',
  transactionCookie: production ? '__Host-signals_login' : 'signals_login',
  csrfHeader: (process.env.CSRF_HEADER_NAME ?? 'x-csrf-token').toLowerCase(),
  renewalThresholdMs: optionalNumber('TOKEN_RENEWAL_THRESHOLD_SECONDS', 30) * 1000,
  idleMs: optionalNumber('SESSION_IDLE_EXPIRY_SECONDS', 30 * 60) * 1000,
  absoluteMs: optionalNumber('SESSION_ABSOLUTE_EXPIRY_SECONDS', 8 * 60 * 60) * 1000,
  proxy: {
    // Defaults to the local backend API when unset; override per environment.
    backendBaseUrl: process.env.SIGNALS_BACKEND_BASE_URL || 'http://127.0.0.1:4100',
    internalToken: process.env.BACKEND_INTERNAL_TOKEN ?? '',
    timeoutMs: optionalNumber('PROXY_BACKEND_TIMEOUT_MS', 30_000),
    allowedMethods: optionalList('PROXY_ALLOWED_METHODS', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      .map(method => method.toUpperCase()),
    allowedRequestHeaders: optionalList('PROXY_ALLOWED_REQUEST_HEADERS', ['content-type', 'x-correlation-id', 'x-requested-with']),
    allowedResponseHeaders: optionalList('PROXY_ALLOWED_RESPONSE_HEADERS', ['content-type', 'x-request-id', 'x-correlation-id', 'cache-control']),
    registryPath: process.env.PROXY_REGISTRY_PATH,
  },
};
if (settings.key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must decode to 32 bytes');
if (production && [settings.origin, settings.callback, settings.issuer].some(v => new URL(v).protocol !== 'https:')) {
  throw new Error('Production requires HTTPS for origin, callback and issuer');
}
if (new URL(settings.callback).origin !== settings.origin) throw new Error('Callback must use APP_ORIGIN');
if (settings.proxy.backendBaseUrl) {
  const backend = new URL(settings.proxy.backendBaseUrl);
  if (production && backend.protocol !== 'https:') throw new Error('SIGNALS_BACKEND_BASE_URL must use HTTPS in production');
}
if (production && !settings.proxy.internalToken) throw new Error('BACKEND_INTERNAL_TOKEN is required in production');

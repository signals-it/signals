import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
export const production = process.env.NODE_ENV === 'production';
function required(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}; run npm run setup:local first`);
  return v;
}
export const settings = {
  database: required('PLATFORM_DATABASE_URL'),
  key: Buffer.from(required('SESSION_ENCRYPTION_KEY'), 'base64'),
  issuer: required('OIDC_ISSUER'),
  clientId: process.env.KEYCLOAK_CLIENT_ID ?? 'signals-bff',
  clientSecret: required('KEYCLOAK_CLIENT_SECRET'),
  origin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  callback: process.env.OIDC_CALLBACK_URL ?? 'http://localhost:5173/auth/callback',
  cookie: production ? '__Host-signals_session' : 'signals_session',
  transactionCookie: production ? '__Host-signals_login' : 'signals_login',
  idleMs: 30 * 60 * 1000,
  absoluteMs: 8 * 60 * 60 * 1000,
};
if (settings.key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must decode to 32 bytes');
if (production && [settings.origin, settings.callback, settings.issuer].some(v => new URL(v).protocol !== 'https:')) {
  throw new Error('Production requires HTTPS for origin, callback and issuer');
}
if (new URL(settings.callback).origin !== settings.origin) throw new Error('Callback must use APP_ORIGIN');

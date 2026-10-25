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
  host: process.env.BACKEND_API_HOST ?? '127.0.0.1',
  port: Number(process.env.BACKEND_API_PORT ?? 4100),
  // Shared secret proving a request came from the authenticated proxy API.
  internalToken: process.env.BACKEND_INTERNAL_TOKEN ?? '',
};
if (production && !settings.internalToken) throw new Error('BACKEND_INTERNAL_TOKEN is required in production');

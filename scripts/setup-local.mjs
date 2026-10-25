import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const env = new URL('.env', root);

let existing = false;
try {
  await access(env);
  existing = true;
} catch {}

if (existing) {
  throw new Error('.env already exists. Preserve it; see docs/setup/local-development.md to regenerate a realm export.');
}

const secret = randomBytes(32).toString('hex');
const corporateSecret = randomBytes(32).toString('hex');

let text = await readFile(new URL('.env.example', root), 'utf8');
text = text
  .replace('GENERATE_CLIENT_SECRET', secret)
  .replace('GENERATE_SESSION_KEY', randomBytes(32).toString('base64'))
  .replace('GENERATE_INTERNAL_TOKEN', randomBytes(32).toString('hex'));

await writeFile(env, text, { mode: 0o600 });

// 1. Process signals realm
const signalsRealm = JSON.parse(
  await readFile(new URL('products/keycloak/realm/signals-realm.template.json', root), 'utf8')
);
signalsRealm.clients[0].secret = secret;
if (signalsRealm.identityProviders?.[0]) {
  signalsRealm.identityProviders[0].config.clientSecret = corporateSecret;
}
await writeFile(
  new URL('products/keycloak/realm-config/signals-realm.json', root),
  JSON.stringify(signalsRealm, null, 2),
  { mode: 0o600 }
);

// 2. Process CorporateXYZ realm
const corporateRealm = JSON.parse(
  await readFile(new URL('products/keycloak/realm/corporate-realm.template.json', root), 'utf8')
);
corporateRealm.clients[0].secret = corporateSecret;
await writeFile(
  new URL('products/keycloak/realm-config/CorporateXYZ-realm.json', root),
  JSON.stringify(corporateRealm, null, 2),
  { mode: 0o600 }
);

console.log('Created local configuration and Keycloak realms. Next: docker compose --env-file .env up -d platform-db keycloak');
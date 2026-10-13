import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const env = new URL('.env', root);
let existing = false;
try { await access(env); existing = true; } catch {}
if (existing) throw new Error('.env already exists. Preserve it; see docs/setup/local-development.md to regenerate a realm export.');
const secret = randomBytes(32).toString('hex');
let text = await readFile(new URL('.env.example', root), 'utf8');
text = text.replace('GENERATE_CLIENT_SECRET',secret).replace('GENERATE_SESSION_KEY',randomBytes(32).toString('base64'));
await writeFile(env,text,{mode:0o600});
const realm = JSON.parse(await readFile(new URL('products/keycloak/realm/signals-realm.template.json',root),'utf8'));
realm.clients[0].secret = secret;
await writeFile(new URL('products/keycloak/realm/signals-realm.json',root),JSON.stringify(realm,null,2),{mode:0o600});
console.log('Created local configuration and Keycloak realm. Next: docker compose --env-file .env up -d platform-db keycloak');

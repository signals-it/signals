import { pool } from './db.js';
import { permissions } from './security.js';
const [subject, slug, role] = process.argv.slice(2);
if (!subject || !slug || !permissions[role]) throw new Error('Usage: npm run user:grant -- KEYCLOAK_SUBJECT TENANT_SLUG tenant_admin|operator|viewer');
try {
  const result = await pool.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role_key)
    SELECT t.id,u.id,$3 FROM tenants t CROSS JOIN platform_users u WHERE t.slug=$2 AND u.keycloak_subject=$1
    ON CONFLICT(tenant_id,user_id) DO UPDATE SET role_key=EXCLUDED.role_key RETURNING tenant_id`, [subject,slug,role]);
  if (!result.rowCount) throw new Error('User must log in once and tenant must exist');
  console.log('Membership granted. Reload Signals.');
} finally { await pool.end(); }

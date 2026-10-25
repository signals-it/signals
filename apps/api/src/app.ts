import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { pool } from './db.js';
import { settings } from './config.js';
import { random, hash, equal, can } from './security.js';

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res, next).catch(next); };

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const incoming = req.headers['x-correlation-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128 ? incoming : random().slice(0, 16);
  res.locals.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
});
app.get('/health/live', (_req, res) => res.json({ status: 'ok', service: 'signals-api' }));
app.get('/health/ready', wrap(async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
}));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'signals-api' }));

/**
 * The backend API is never called by a browser: only the proxy API may reach
 * it. The proxy proves this with a shared secret. It is enforced on every
 * backend route except the health probes, which need no shared secret.
 */
app.use('/signals/api/v1', (req, res, next) => {
  if (settings.internalToken && !equal(req.headers['x-signals-internal-token'], settings.internalToken)) {
    res.status(401).json({ error: 'Unauthorized' }); return;
  }
  next();
});
app.get('/signals/api/v1/health', (_req, res) => res.json({ status: 'ok', service: 'signals-api' }));

/**
 * The proxy forwards the opaque server-side session id. It is validated
 * against the shared session tables, preserving the platform's
 * database-backed authorization without exposing tokens or cookies beyond
 * the proxy.
 */
app.use('/signals/api/v1', wrap(async (req, res, next) => {
  const sessionId = req.headers['x-signals-session'];
  if (typeof sessionId !== 'string') { res.status(401).json({ error: 'Unauthorized' }); return; }
  const result = await pool.query(`SELECT s.user_id FROM auth_sessions s JOIN platform_users u ON u.id=s.user_id
    WHERE s.id_hash=$1 AND s.expires_at>now() AND s.absolute_expires_at>now() AND u.status='active'`, [hash(sessionId)]);
  if (!result.rowCount) { res.status(401).json({ error: 'Session expired' }); return; }
  res.locals.userId = result.rows[0].user_id;
  next();
}));
app.use('/signals/api/v1/tenants/:tenantId', wrap(async (req, res, next) => {
  const tenantId = req.params.tenantId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tenantId))) {
    res.status(400).json({ error: 'Invalid tenant ID' }); return;
  }
  const result = await pool.query(`SELECT m.role_key FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=$1 AND m.user_id=$2 AND t.status='active'`, [tenantId, res.locals.userId]);
  if (!result.rowCount) { res.status(403).json({ error: 'Tenant access denied' }); return; }
  res.locals.role = result.rows[0].role_key; res.locals.tenantId = tenantId;
  next();
}));
const requirePermission = (permission: string) => (_req: Request, res: Response, next: NextFunction) => {
  if (!can(res.locals.role, permission)) { res.status(403).json({ error: 'Permission denied' }); return; }
  next();
};
app.get('/signals/api/v1/tenants/:tenantId/integrations', requirePermission('integrations:read'), (_req, res) => {
  res.json({ integrations: [
    { name: 'GLPI', configured: false, mode: 'Adapter scaffold', description: 'ITSM and assets' },
    { name: 'Zabbix', configured: false, mode: 'Adapter scaffold', description: 'Monitoring' },
    { name: 'Keycloak', configured: true, mode: 'OIDC proxy', description: 'Identity and SSO' },
  ] });
});
app.get('/signals/api/v1/tenants/:tenantId/administration', requirePermission('administration:read'),
  (_req, res) => res.json({ tenantId: res.locals.tenantId, role: res.locals.role }));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  // Avoid logging tokens, session identifiers or request bodies.
  console.error(JSON.stringify({ event: 'request_failed', correlationId: res.locals.correlationId, method: req.method,
    path: req.path, error: error instanceof Error ? error.name : 'Error' }));
  res.status(500).json({ error: 'Request failed.' });
});

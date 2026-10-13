import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cookies from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import * as oidc from 'openid-client';
import { pool } from './db.js';
import { settings, production } from './config.js';
import { random, hash, seal, open, equal, can } from './security.js';

type Tokens = { access_token: string; refresh_token?: string; id_token?: string; expires: number };
type Session = { id_hash: string; user_id: string; csrf_token: string; token_payload: string; absolute_expires_at: Date };
type Login = { verifier: string; state: string; nonce: string };
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res, next).catch(next); };
let configuration: Promise<oidc.Configuration> | undefined;
function provider() {
  if (!configuration) {
    configuration = oidc.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret,
      undefined, production ? undefined : { execute: [oidc.allowInsecureRequests] }).catch(error => {
        configuration = undefined; throw error;
      });
  }
  return configuration;
}
function toTokens(t: oidc.TokenEndpointResponse, previous?: Tokens): Tokens {
  return { access_token: t.access_token, refresh_token: t.refresh_token ?? previous?.refresh_token,
    id_token: t.id_token ?? previous?.id_token, expires: Date.now() + Number(t.expires_in ?? 60) * 1000 };
}
export const app = express();
app.disable('x-powered-by');
if (production) app.set('trust proxy', 1); // Exactly one trusted reverse proxy; see deployment guide.
app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use(cookies());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== settings.origin) {
    res.status(403).json({ error: 'Invalid request origin' }); return;
  }
  next();
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'signals-api' }));
const loginLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
app.get('/auth/login', loginLimit, wrap(async (req, res) => {
  const config = await provider();
  const id = random(), login: Login = { verifier: oidc.randomPKCECodeVerifier(), state: oidc.randomState(), nonce: oidc.randomNonce() };
  if (req.cookies[settings.transactionCookie]) await pool.query('DELETE FROM auth_transactions WHERE id_hash=$1', [hash(req.cookies[settings.transactionCookie])]);
  await pool.query('INSERT INTO auth_transactions(id_hash,payload,expires_at) VALUES($1,$2,now()+interval \'5 minutes\')', [hash(id), seal(login, settings.key)]);
  res.cookie(settings.transactionCookie, id, { ...cookieOptions, maxAge: 5 * 60_000 });
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: settings.callback, scope: 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(login.verifier), code_challenge_method: 'S256', state: login.state, nonce: login.nonce });
  res.redirect(url.href);
}));
app.get('/auth/callback', loginLimit, wrap(async (req, res) => {
  const cookie = req.cookies[settings.transactionCookie];
  res.clearCookie(settings.transactionCookie, cookieOptions);
  if (typeof cookie !== 'string') { res.status(400).send('Missing login transaction. Start again.'); return; }
  // DELETE RETURNING makes the callback transaction single use even across replicas.
  const result = await pool.query('DELETE FROM auth_transactions WHERE id_hash=$1 AND expires_at>now() RETURNING payload', [hash(cookie)]);
  if (!result.rowCount) { res.status(400).send('Login expired or already used. Start again.'); return; }
  const login = open<Login>(result.rows[0].payload, settings.key);
  const config = await provider();
  const callback = new URL(settings.callback); callback.search = new URL(req.originalUrl, settings.origin).search;
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: login.verifier, expectedState: login.state, expectedNonce: login.nonce, idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error('Missing subject');
  const db = await pool.connect();
  const id = random();
  try {
    await db.query('BEGIN');
    const user = await db.query(`INSERT INTO platform_users(keycloak_subject,email,display_name) VALUES($1,$2,$3)
      ON CONFLICT(keycloak_subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,updated_at=now()
      RETURNING id,status`, [claims.sub, claims.email ?? null, claims.name ?? claims.preferred_username ?? claims.sub]);
    if (user.rows[0].status !== 'active') throw new Error('Account disabled');
    if (req.cookies[settings.cookie]) await db.query('DELETE FROM auth_sessions WHERE id_hash=$1', [hash(req.cookies[settings.cookie])]);
    await db.query(`INSERT INTO auth_sessions(id_hash,user_id,csrf_token,token_payload,expires_at,absolute_expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [hash(id), user.rows[0].id, random(), seal(toTokens(tokens), settings.key),
      new Date(Date.now()+settings.idleMs), new Date(Date.now()+settings.absoluteMs)]);
    await db.query(`INSERT INTO audit_events(actor_subject,action,resource_type) VALUES($1,'auth.login','session')`, [claims.sub]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  res.cookie(settings.cookie, id, { ...cookieOptions, maxAge: settings.absoluteMs });
  res.redirect(settings.origin);
}));

// Row lock serializes refresh token rotation across requests and API replicas.
const authenticate = wrap(async (req, res, next) => {
  const id = req.cookies[settings.cookie];
  if (typeof id !== 'string') { res.status(401).json({ error: 'Login required' }); return; }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await db.query(`SELECT s.* FROM auth_sessions s JOIN platform_users u ON u.id=s.user_id
      WHERE s.id_hash=$1 AND s.expires_at>now() AND s.absolute_expires_at>now() AND u.status='active' FOR UPDATE OF s`, [hash(id)]);
    if (!result.rowCount) { await db.query('ROLLBACK'); res.clearCookie(settings.cookie, cookieOptions); res.status(401).json({ error: 'Session expired' }); return; }
    const session: Session = result.rows[0];
    let tokens = open<Tokens>(session.token_payload, settings.key);
    if (tokens.expires <= Date.now()+30_000) {
      try {
        if (!tokens.refresh_token) throw new Error('Missing refresh token');
        tokens = toTokens(await oidc.refreshTokenGrant(await provider(), tokens.refresh_token), tokens);
      } catch {
        await db.query('DELETE FROM auth_sessions WHERE id_hash=$1', [session.id_hash]); await db.query('COMMIT');
        res.clearCookie(settings.cookie, cookieOptions); res.status(401).json({ error: 'Sign in again' }); return;
      }
    }
    await db.query('UPDATE auth_sessions SET token_payload=$2,expires_at=LEAST($3,absolute_expires_at) WHERE id_hash=$1',
      [session.id_hash,seal(tokens,settings.key),new Date(Date.now()+settings.idleMs)]);
    await db.query('COMMIT');
    res.locals.session = session;
    res.locals.tokens = tokens;
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  next();
});
app.use('/api', (req, res, next) => { if (req.path === '/health') next(); else authenticate(req, res, next); });
const csrf = (req: Request, res: Response, next: NextFunction) => {
  if (!equal(req.headers['x-csrf-token'], res.locals.session?.csrf_token)) { res.status(403).json({ error: 'Invalid CSRF token' }); return; }
  next();
};
app.get('/api/session', wrap(async (_req, res) => {
  const user = await pool.query('SELECT id,keycloak_subject,email,display_name FROM platform_users WHERE id=$1', [res.locals.session.user_id]);
  const memberships = await pool.query(`SELECT t.id,t.name,t.slug,m.role_key FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.user_id=$1 AND t.status='active' ORDER BY t.name`, [res.locals.session.user_id]);
  res.json({ user: user.rows[0], memberships: memberships.rows, csrfToken: res.locals.session.csrf_token });
}));
app.post('/api/logout', csrf, wrap(async (_req, res) => {
  const tokens: Tokens = res.locals.tokens;
  await pool.query('DELETE FROM auth_sessions WHERE id_hash=$1', [res.locals.session.id_hash]);
  res.clearCookie(settings.cookie, cookieOptions);
  // Local logout is complete even if discovery fails. Browser then ends the IdP session.
  let logoutUrl = settings.origin;
  try { logoutUrl = oidc.buildEndSessionUrl(await provider(), {
    id_token_hint: tokens.id_token ?? '', post_logout_redirect_uri: settings.origin, client_id: settings.clientId,
  }).href; } catch { /* IdP unavailable: local session already deleted. */ }
  res.json({ logoutUrl });
}));
app.use('/api/tenants/:tenantId', wrap(async (req, res, next) => {
  const tenantId = req.params.tenantId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tenantId))) {
    res.status(400).json({ error: 'Invalid tenant ID' }); return;
  }
  const result = await pool.query(`SELECT m.role_key FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=$1 AND m.user_id=$2 AND t.status='active'`, [tenantId,res.locals.session.user_id]);
  if (!result.rowCount) { res.status(403).json({ error: 'Tenant access denied' }); return; }
  res.locals.role = result.rows[0].role_key; res.locals.tenantId = tenantId;
  next();
}));
const requirePermission = (permission: string) => (_req: Request, res: Response, next: NextFunction) => {
  if (!can(res.locals.role, permission)) { res.status(403).json({ error: 'Permission denied' }); return; }
  next();
};
app.get('/api/tenants/:tenantId/integrations', requirePermission('integrations:read'), (_req, res) => {
  res.json({ integrations: [
    { name: 'GLPI', configured: false, mode: 'Adapter scaffold', description: 'ITSM and assets' },
    { name: 'Zabbix', configured: false, mode: 'Adapter scaffold', description: 'Monitoring' },
    { name: 'Keycloak', configured: true, mode: 'OIDC BFF', description: 'Identity and SSO' },
  ] });
});
app.get('/api/tenants/:tenantId/administration', requirePermission('administration:read'), (_req, res) => res.json({ tenantId: res.locals.tenantId, role: res.locals.role }));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Avoid logging tokens, callback query strings or provider error bodies.
  console.error('Request failed:', error instanceof Error ? error.name : 'Error');
  res.status(500).json({ error: 'Request failed. Check configuration or restart login.' });
});

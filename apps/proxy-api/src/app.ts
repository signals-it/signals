import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cookies from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { pool } from './db.js';
import { settings, production } from './config.js';
import { random, hash, seal, open, equal } from './security.js';
import { KeycloakAuthProvider, randomVerifier, randomState, randomNonce, calculateCodeChallenge } from './auth/keycloak.js';
import type { TokenSet } from './auth/provider.js';
import { loadRules, createRegistry } from './proxy/registry.js';
import { validateProxyRequest } from './proxy/validator.js';
import { forwardToBackend } from './proxy/forwarder.js';
import { filterResponseHeaders } from './proxy/response.js';

type Tokens = { access_token: string; refresh_token?: string; id_token?: string; expires: number };
type Session = { id_hash: string; user_id: string; csrf_token: string; token_payload: string; absolute_expires_at: Date };
type Login = { verifier: string; state: string; nonce: string };

const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res, next).catch(next); };

const provider = new KeycloakAuthProvider({
  issuer: settings.issuer,
  clientId: settings.clientId,
  clientSecret: settings.clientSecret,
  postLogoutRedirectUri: settings.origin,
});
const registry = createRegistry(loadRules(settings.proxy.registryPath), settings.proxy.backendBaseUrl);

function fromTokenSet(set: TokenSet, previous?: Tokens): Tokens {
  return { access_token: set.accessToken, refresh_token: set.refreshToken ?? previous?.refresh_token,
    id_token: set.idToken ?? previous?.id_token, expires: set.expiresAt.getTime() };
}

export const app = express();
app.disable('x-powered-by');
if (production) app.set('trust proxy', 1); // Exactly one trusted reverse proxy; see deployment guide.
app.use(helmet());
app.use(express.json({ limit: '32kb' }));
app.use(cookies());
app.use((req, res, next) => {
  const incoming = req.headers['x-correlation-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128 ? incoming : random().slice(0, 16);
  res.locals.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
});
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== settings.origin) {
    res.status(403).json({ error: 'Invalid request origin' }); return;
  }
  next();
});
app.get('/health/live', (_req, res) => res.json({ status: 'ok', service: 'signals-proxy-api' }));
app.get('/health/ready', wrap(async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await provider.ready();
    res.json({ status: 'ready' });
  } catch { res.status(503).json({ status: 'unavailable' }); }
}));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'signals-proxy-api' }));
const loginLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
app.get('/auth/login', loginLimit, wrap(async (req, res) => {
  const id = random(), login: Login = { verifier: randomVerifier(), state: randomState(), nonce: randomNonce() };
  if (req.cookies[settings.transactionCookie]) await pool.query('DELETE FROM auth_transactions WHERE id_hash=$1', [hash(req.cookies[settings.transactionCookie])]);
  await pool.query('INSERT INTO auth_transactions(id_hash,payload,expires_at) VALUES($1,$2,now()+interval \'5 minutes\')', [hash(id), seal(login, settings.key)]);
  res.cookie(settings.transactionCookie, id, { ...cookieOptions, maxAge: 5 * 60_000 });
  res.redirect(await provider.buildAuthorizationUrl({
    state: login.state, nonce: login.nonce, redirectUri: settings.callback, scope: 'openid profile email',
    codeChallenge: await calculateCodeChallenge(login.verifier),
  }));
}));
app.get('/auth/callback', loginLimit, wrap(async (req, res) => {
  const cookie = req.cookies[settings.transactionCookie];
  res.clearCookie(settings.transactionCookie, cookieOptions);
  if (typeof cookie !== 'string') { res.status(400).send('Missing login transaction. Start again.'); return; }
  // DELETE RETURNING makes the callback transaction single use even across replicas.
  const result = await pool.query('DELETE FROM auth_transactions WHERE id_hash=$1 AND expires_at>now() RETURNING payload', [hash(cookie)]);
  if (!result.rowCount) { res.status(400).send('Login expired or already used. Start again.'); return; }
  const login = open<Login>(result.rows[0].payload, settings.key);
  const callback = new URL(settings.callback); callback.search = new URL(req.originalUrl, settings.origin).search;
  const { tokens: tokenSet, claims } = await provider.exchangeCode({
    url: callback, codeVerifier: login.verifier, state: login.state, nonce: login.nonce,
  });
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
      VALUES($1,$2,$3,$4,$5,$6)`, [hash(id), user.rows[0].id, random(), seal(fromTokenSet(tokenSet), settings.key),
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
    if (tokens.expires <= Date.now()+settings.renewalThresholdMs) {
      try {
        if (!tokens.refresh_token) throw new Error('Missing refresh token');
        tokens = fromTokenSet(await provider.refreshToken(tokens.refresh_token), tokens);
      } catch {
        await db.query('DELETE FROM auth_sessions WHERE id_hash=$1', [session.id_hash]); await db.query('COMMIT');
        res.clearCookie(settings.cookie, cookieOptions); res.status(401).json({ error: 'Sign in again' }); return;
      }
    }
    await db.query('UPDATE auth_sessions SET token_payload=$2,expires_at=LEAST($3,absolute_expires_at) WHERE id_hash=$1',
      [session.id_hash,seal(tokens,settings.key),new Date(Date.now()+settings.idleMs)]);
    await db.query('COMMIT');
    res.locals.session = session;
    res.locals.sessionId = id;
    res.locals.tokens = tokens;
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  next();
});
app.use('/api', (req, res, next) => { if (req.path === '/health') next(); else authenticate(req, res, next); });
const csrf = (req: Request, res: Response, next: NextFunction) => {
  if (!equal(req.headers[settings.csrfHeader], res.locals.session?.csrf_token)) { res.status(403).json({ error: 'Invalid CSRF token' }); return; }
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
  try { logoutUrl = await provider.endSessionUrl(tokens.id_token ?? null); } catch { /* IdP unavailable: local session already deleted. */ }
  res.json({ logoutUrl });
}));
// Centralized authenticated proxy. The SPA never talks to the backend directly.
app.post('/api/proxy', csrf, wrap(async (req, res) => {
  const validation = validateProxyRequest(req.body, settings.proxy);
  if (!validation.ok) {
    res.status(validation.status).json({ error: 'validation_error', field: validation.field, detail: validation.error }); return;
  }
  const { request } = validation;
  const target = registry.resolve(request.method, request.path);
  if (!target) { res.status(403).json({ error: 'Backend path not permitted' }); return; }
  const tokens: Tokens = res.locals.tokens;
  const result = await forwardToBackend(target, request, {
    accessToken: tokens.access_token, timeoutMs: settings.proxy.timeoutMs, correlationId: res.locals.correlationId,
    internalSessionId: res.locals.sessionId, internalToken: settings.proxy.internalToken,
  });
  if (!result.ok) {
    res.status(result.kind === 'timeout' ? 408 : 502)
      .json({ error: result.kind === 'timeout' ? 'Backend request timed out' : 'Backend unreachable' }); return;
  }
  res.json({ status: result.status, body: result.body,
    headers: filterResponseHeaders(result.headers, settings.proxy.allowedResponseHeaders) });
}));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ 
    event: 'request_failed', 
    correlationId: res.locals.correlationId, 
    method: req.method,
    path: req.path, 
    error: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),  
    cause: error instanceof Error ? (error as any).cause : undefined,  
    stack: error instanceof Error ? error.stack?.split('\n').slice(0,5) : undefined  
  }));
  res.status(500).json({ error: 'Request failed. Check configuration or restart login.' });
});

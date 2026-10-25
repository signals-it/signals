import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';

const sql = new PGlite();
const key = randomBytes(32);
let backend: Server, app: express.Express, pool: any;
let seal: (data: unknown, key: Buffer) => string, hash: (value: string) => string;
let userId: string, backendHits = 0;

before(async () => {
  const backendApp = express();
  backendApp.use(express.json());
  backendApp.all('/signals/api/v1/*', (req, res) => {
    backendHits++;
    if (req.path.endsWith('/boom')) { res.status(502).json({ error: 'boom' }); return; }
    if (req.path.endsWith('/missing')) { res.status(404).json({ error: 'nope' }); return; }
    res.setHeader('X-Request-Id', 'req-1');
    res.setHeader('Set-Cookie', 'backend=leak');
    res.json({
      method: req.method, path: req.path, query: req.query, body: req.body,
      authorization: req.header('authorization') ?? null, cookie: req.header('cookie') ?? null,
      correlation: req.header('x-correlation-id') ?? null,
    });
  });
  backend = backendApp.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => backend.once('listening', resolve));
  const backendUrl = `http://127.0.0.1:${(backend.address() as any).port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test', PLATFORM_DATABASE_URL: 'postgres://unused', SESSION_ENCRYPTION_KEY: key.toString('base64'),
    OIDC_ISSUER: 'http://127.0.0.1:1/realms/test', KEYCLOAK_CLIENT_SECRET: 'secret',
    APP_ORIGIN: 'http://localhost:5173', OIDC_CALLBACK_URL: 'http://localhost:5173/auth/callback',
    SIGNALS_BACKEND_BASE_URL: `http://127.0.0.1:${(backend.address() as any).port}`, PROXY_BACKEND_TIMEOUT_MS: '1000',
  });
  ({ pool } = await import('../src/db.js'));
  const query = async (text: string, args: unknown[] = []) => {
    const r = await sql.query(text, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  pool.query = query; pool.connect = async () => ({ query, release() {} });
  for (const name of ['001_platform_baseline.sql', '002_auth.sql']) {
    const text = await readFile(new URL(`../../../database/migrations/${name}`, import.meta.url), 'utf8');
    await sql.exec(text.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  }
  ({ seal, hash } = await import('../src/security.js'));
  ({ app } = await import('../src/app.js'));
  const user: any = await sql.query("INSERT INTO platform_users(keycloak_subject,email,display_name) VALUES('proxy-subject','p@example.com','Proxy User') RETURNING id");
  userId = user.rows[0].id;
});
after(async () => { backend.closeAllConnections?.(); backend.close(); await sql.close(); });

async function session(accessToken = 'opaque-token') {
  const id = randomBytes(32).toString('base64url');
  await sql.query(`INSERT INTO auth_sessions(id_hash,user_id,csrf_token,token_payload,expires_at,absolute_expires_at)
    VALUES($1,$2,'csrf-test',$3,$4,$5)`,
  [hash(id), userId, seal({ access_token: accessToken, refresh_token: 'refresh', id_token: 'id', expires: Date.now() + 300_000 }, key),
    new Date(Date.now() + 1_800_000), new Date(Date.now() + 28_800_000)]);
  return id;
}
const origin = 'http://localhost:5173';
const proxy = (sessionId?: string) => {
  const req = request(app).post('/api/proxy').set('Origin', origin);
  if (sessionId) req.set('Cookie', `signals_session=${sessionId}`);
  return req;
};

test('centralized proxy integration', async t => {
  await t.test('requires an authenticated session', async () => {
    await proxy().send({ method: 'GET', path: '/signals/api/v1/hosts' }).expect(401);
  });
  await t.test('requires the CSRF header', async () => {
    await proxy(await session()).send({ method: 'GET', path: '/signals/api/v1/hosts' }).expect(403);
  });
  await t.test('enforces the method allowlist', async () => {
    const r = await proxy(await session()).set('X-CSRF-Token', 'csrf-test').send({ method: 'TRACE', path: '/signals/api/v1/hosts' }).expect(400);
    assert.equal(r.body.error, 'validation_error');
    assert.equal(r.body.field, 'method');
  });
  await t.test('rejects paths outside the registry and traversal attempts', async () => {
    await proxy(await session()).set('X-CSRF-Token', 'csrf-test').send({ method: 'GET', path: '/internal/secrets' }).expect(403);
    await proxy(await session()).set('X-CSRF-Token', 'csrf-test').send({ method: 'GET', path: '/signals/../../etc/passwd' }).expect(400);
  });
  await t.test('drops payloads on body-less methods', async () => {
    const r = await proxy(await session()).set('X-CSRF-Token', 'csrf-test')
      .send({ method: 'GET', path: '/signals/api/v1/hosts', payload: { ignored: true } }).expect(200);
    assert.deepEqual(r.body.body.body, {});
  });
  await t.test('rejects blocked headers such as Authorization', async () => {
    await proxy(await session()).set('X-CSRF-Token', 'csrf-test')
      .send({ method: 'GET', path: '/signals/api/v1/hosts', headers: { Authorization: 'Bearer attacker' } }).expect(403);
  });
  await t.test('forwards an allowlisted call with the injected bearer token and no cookie', async () => {
    const id = await session('server-side-token');
    const r = await proxy(id).set('X-CSRF-Token', 'csrf-test').set('X-Correlation-Id', 'corr-123')
      .send({ method: 'GET', path: '/signals/api/v1/hosts', queryParams: { page: 2 } }).expect(200);
    assert.equal(r.body.status, 200);
    assert.equal(r.body.body.authorization, 'Bearer server-side-token');
    assert.equal(r.body.body.cookie, null);
    assert.deepEqual(r.body.body.query, { page: '2' });
    assert.equal(r.body.body.correlation, 'corr-123');
    assert.equal(r.body.headers['x-request-id'], 'req-1');
    assert.equal(r.body.headers['set-cookie'], undefined);
    assert.equal(r.headers['x-correlation-id'], 'corr-123');
  });
  await t.test('forwards a backend error status inside the envelope', async () => {
    const r = await proxy(await session()).set('X-CSRF-Token', 'csrf-test').send({ method: 'GET', path: '/signals/api/v1/missing' }).expect(200);
    assert.equal(r.body.status, 404);
  });
  await t.test('forwards a persistent backend 502 after one idempotent retry', async () => {
    const before = backendHits;
    const r = await proxy(await session()).set('X-CSRF-Token', 'csrf-test').send({ method: 'GET', path: '/signals/api/v1/boom' }).expect(200);
    assert.equal(r.body.status, 502);
    assert.equal(backendHits - before, 2);
  });
  await t.test('forwards POST payloads without retrying', async () => {
    const before = backendHits;
    const r = await proxy(await session()).set('X-CSRF-Token', 'csrf-test')
      .send({ method: 'POST', path: '/signals/api/v1/things', payload: { name: 'widget' }, queryParams: { dry: '1' } }).expect(200);
    assert.equal(r.body.status, 200);
    assert.deepEqual(r.body.body.body, { name: 'widget' });
    assert.deepEqual(r.body.body.query, { dry: '1' });
    assert.equal(r.body.body.authorization, 'Bearer opaque-token');
    assert.equal(backendHits - before, 1);
  });
});

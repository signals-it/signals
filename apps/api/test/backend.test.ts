import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';

const sql = new PGlite();
const internalToken = 'test-internal-token';
let app: express.Express, pool: any, hash: (value: string) => string;
let userId: string, tenantId: string;

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', PLATFORM_DATABASE_URL: 'postgres://unused', BACKEND_INTERNAL_TOKEN: internalToken,
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
  ({ hash } = await import('../src/security.js'));
  ({ app } = await import('../src/app.js'));
  const user: any = await sql.query("INSERT INTO platform_users(keycloak_subject,email,display_name) VALUES('backend-subject','b@example.com','Backend User') RETURNING id");
  userId = user.rows[0].id;
  const tenant: any = await sql.query("SELECT id FROM tenants WHERE slug='signals-demo'");
  tenantId = tenant.rows[0].id;
});
after(async () => { await sql.close(); });

async function session(expired = false) {
  const id = randomBytes(32).toString('base64url');
  await sql.query(`INSERT INTO auth_sessions(id_hash,user_id,csrf_token,token_payload,expires_at,absolute_expires_at)
    VALUES($1,$2,'csrf',$3,$4,$5)`, [hash(id), userId, 'opaque',
    new Date(Date.now() + (expired ? -1000 : 1_800_000)), new Date(Date.now() + 28_800_000)]);
  return id;
}
const call = (path: string, sessionId?: string, token = internalToken) => {
  const req = request(app).get(path);
  req.set('X-Signals-Internal-Token', token);
  if (sessionId) req.set('X-Signals-Session', sessionId);
  return req;
};

test('backend API requires the proxy shared secret and a valid session', async t => {
  await t.test('public health endpoints', async () => {
    await request(app).get('/health/live').expect(200);
    await request(app).get('/health/ready').expect(200);
    await request(app).get('/signals/api/v1/health').set('X-Signals-Internal-Token', internalToken).expect(200);
  });
  await t.test('rejects a missing or wrong internal token', async () => {
    await request(app).get('/signals/api/v1/health').expect(401);
    await request(app).get('/signals/api/v1/health').set('X-Signals-Internal-Token', 'wrong').expect(401);
  });
  await t.test('rejects a missing or expired session', async () => {
    await request(app).get(`/signals/api/v1/tenants/${tenantId}/integrations`).set('X-Signals-Internal-Token', internalToken).expect(401);
    await call(`/signals/api/v1/tenants/${tenantId}/integrations`, await session(true)).expect(401);
  });
});

test('backend API enforces tenant membership and roles from the shared session DB', async t => {
  await t.test('viewer sees integrations but not administration', async () => {
    await sql.query("INSERT INTO tenant_memberships(tenant_id,user_id,role_key) VALUES($1,$2,'viewer') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role_key='viewer'", [tenantId, userId]);
    const c = await session();
    const r = await call(`/signals/api/v1/tenants/${tenantId}/integrations`, c).expect(200);
    assert.ok(Array.isArray(r.body.integrations));
    await call(`/signals/api/v1/tenants/${tenantId}/administration`, c).expect(403);
  });
  await t.test('admin role grants administration', async () => {
    await sql.query("UPDATE tenant_memberships SET role_key='tenant_admin' WHERE user_id=$1", [userId]);
    await call(`/signals/api/v1/tenants/${tenantId}/administration`, await session()).expect(200);
  });
  await t.test('invalid, unknown and unregistered tenants are rejected', async () => {
    await call('/signals/api/v1/tenants/bad/integrations', await session()).expect(400);
    await call(`/signals/api/v1/tenants/${tenantId}/integrations`).expect(401);
    await call('/signals/api/v1/tenants/00000000-0000-4000-8000-000000000000/integrations', await session()).expect(403);
  });
  await t.test('membership revocation and suspended tenant fail closed', async () => {
    const c = await session();
    await sql.query("UPDATE tenant_memberships SET role_key='viewer' WHERE user_id=$1", [userId]);
    await sql.query("UPDATE tenants SET status='suspended' WHERE id=$1", [tenantId]);
    await call(`/signals/api/v1/tenants/${tenantId}/integrations`, c).expect(403);
    await sql.query("UPDATE tenants SET status='active' WHERE id=$1", [tenantId]);
    await sql.query('DELETE FROM tenant_memberships WHERE user_id=$1', [userId]);
    await call(`/signals/api/v1/tenants/${tenantId}/integrations`, c).expect(403);
  });
  await t.test('disabled user session rejected', async () => {
    await sql.query("INSERT INTO tenant_memberships(tenant_id,user_id,role_key) VALUES($1,$2,'viewer') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role_key='viewer'", [tenantId, userId]);
    const c = await session();
    await sql.query("UPDATE platform_users SET status='disabled' WHERE id=$1", [userId]);
    await call(`/signals/api/v1/tenants/${tenantId}/integrations`, c).expect(401);
    await sql.query("UPDATE platform_users SET status='active' WHERE id=$1", [userId]);
  });
});

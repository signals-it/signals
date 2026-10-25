import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import type { Server } from 'node:http';

const sql = new PGlite();
const key = randomBytes(32);
let issuer: string, provider: Server, app: express.Express, pool: any;
let seal: (data: unknown, key: Buffer) => string, hash: (value: string) => string;
let authorize: URL;
let nonceOverride: string | undefined;
let refreshCount = 0;
const subject = 'test-keycloak-subject';
let userId: string, tenantId: string;

before(async () => {
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey); jwk.kid = 'test';
  const idp = express(); idp.use(express.urlencoded({ extended: false }));
  idp.get('/.well-known/openid-configuration', (_req, res) => res.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'], subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
  }));
  idp.get('/jwks', (_req,res) => res.json({ keys: [jwk] }));
  idp.post('/token', async (req,res) => {
    if (req.body.client_id !== 'signals-bff' || req.body.client_secret !== 'test-secret') { res.status(401).json({error:'invalid_client'}); return; }
    if (req.body.grant_type === 'refresh_token') {
      refreshCount++; res.json({ access_token:'refreshed',refresh_token:'rotated',token_type:'Bearer',expires_in:300 }); return;
    }
    const challenge = createHash('sha256').update(req.body.code_verifier || '').digest('base64url');
    if (challenge !== authorize.searchParams.get('code_challenge')) { res.status(400).json({error:'invalid_grant'}); return; }
    const token = await new SignJWT({ nonce: nonceOverride ?? authorize.searchParams.get('nonce'), name:'Test User',email:'test@example.com' })
      .setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('signals-bff')
      .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    res.json({ access_token:'opaque-access',refresh_token:'refresh',id_token:token,token_type:'Bearer',expires_in:300 });
  });
  provider = idp.listen(0,'127.0.0.1');
  await new Promise<void>(resolve => provider.once('listening',resolve));
  issuer = `http://127.0.0.1:${(provider.address() as any).port}`;
  Object.assign(process.env,{ NODE_ENV:'test',PLATFORM_DATABASE_URL:'postgres://unused',SESSION_ENCRYPTION_KEY:key.toString('base64'),
    OIDC_ISSUER:issuer,KEYCLOAK_CLIENT_SECRET:'test-secret',APP_ORIGIN:'http://localhost:5173',OIDC_CALLBACK_URL:'http://localhost:5173/auth/callback' });
  ({ pool } = await import('../src/db.js'));
  // Embedded PostgreSQL executes real SQL; replace only the network pool transport.
  const query = async (text: string, args: unknown[] = []) => {
    const r = await sql.query(text,args); return {rows:r.rows,rowCount:r.rows.length || r.affectedRows || 0};
  };
  pool.query = query; pool.connect = async () => ({ query, release() {} });
  for (const name of ['001_platform_baseline.sql','002_auth.sql']) {
    const text = await readFile(new URL(`../../../database/migrations/${name}`, import.meta.url),'utf8');
    await sql.exec(text.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','')); // gen_random_uuid is built-in.
  }
  ({ seal, hash } = await import('../src/security.js'));
  ({ app } = await import('../src/app.js'));
});
after(async () => { provider.closeAllConnections(); provider.close(); await sql.close(); });

const cookie = (r: any, name: string) => r.headers['set-cookie'].find((s:string) => s.startsWith(name+'=')).split(';')[0];
async function startLogin() {
  const r = await request(app).get('/auth/login').expect(302);
  authorize = new URL(r.headers.location);
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  return cookie(r,'signals_login');
}
async function createSession(role='viewer',expired=false,tokenExpired=false) {
  const id = randomBytes(32).toString('base64url');
  await sql.query(`INSERT INTO auth_sessions(id_hash,user_id,csrf_token,token_payload,expires_at,absolute_expires_at)
    VALUES($1,$2,'csrf-test',$3,$4,$5)`,[hash(id),userId,seal({access_token:'access',refresh_token:'refresh',id_token:'id',expires:Date.now()+(tokenExpired?-1000:300000)},key),
      new Date(Date.now()+(expired?-1000:1800000)),new Date(Date.now()+28800000)]);
  await sql.query('UPDATE tenant_memberships SET role_key=$1 WHERE user_id=$2',[role,userId]);
  return `signals_session=${id}`;
}

test('OIDC and protected API integration', async t => {
  await t.test('public health and unauthenticated API', async () => {
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/session').expect(401);
  });
  await t.test('wrong state rejected and transaction consumed', async () => {
    const c = await startLogin();
    await request(app).get('/auth/callback?code=code&state=wrong').set('Cookie',c).expect(500);
    await request(app).get(`/auth/callback?code=code&state=${authorize.searchParams.get('state')}`).set('Cookie',c).expect(400);
  });
  await t.test('wrong nonce rejected', async () => {
    const c = await startLogin(); nonceOverride='wrong';
    await request(app).get(`/auth/callback?code=code&state=${authorize.searchParams.get('state')}`).set('Cookie',c).expect(500);
    nonceOverride=undefined;
  });
  await t.test('successful callback, encrypted persistence, cookie and no automatic tenant access', async () => {
    const c = await startLogin();
    const r = await request(app).get(`/auth/callback?code=code&state=${authorize.searchParams.get('state')}`).set('Cookie',c).expect(302);
    const s = cookie(r,'signals_session');
    assert.match(r.headers['set-cookie'].join(';'),/HttpOnly/); assert.match(r.headers['set-cookie'].join(';'),/SameSite=Lax/);
    const info = await request(app).get('/api/session').set('Cookie',s).expect(200);
    assert.equal(info.body.user.keycloak_subject,subject); assert.deepEqual(info.body.memberships,[]);
    assert.equal(info.body.access_token,undefined); userId=info.body.user.id;
    const records:any = await sql.query('SELECT * FROM auth_sessions');
    assert.ok(!records.rows[0].token_payload.includes('opaque-access'));
    const tenant:any = await sql.query("SELECT id FROM tenants WHERE slug='signals-demo'"); tenantId=tenant.rows[0].id;
    await sql.query("INSERT INTO tenant_memberships(tenant_id,user_id,role_key) VALUES($1,$2,'viewer')",[tenantId,userId]);
  });
  await t.test('expired session denied', async () => {
    await request(app).get('/api/session').set('Cookie',await createSession('viewer',true)).expect(401);
  });
  await t.test('absolute expiry and disabled user fail closed', async () => {
    const c=await createSession();
    await sql.query("UPDATE auth_sessions SET absolute_expires_at=now()-interval '1 second' WHERE id_hash=$1",[hash(c.split('=')[1])]);
    await request(app).get('/api/session').set('Cookie',c).expect(401);
    const active=await createSession();
    await sql.query("UPDATE platform_users SET status='disabled' WHERE id=$1",[userId]);
    await request(app).get('/api/session').set('Cookie',active).expect(401);
    await sql.query("UPDATE platform_users SET status='active' WHERE id=$1",[userId]);
  });
  await t.test('refresh token rotation persisted', async () => {
    const c=await createSession('viewer',false,true);
    await request(app).get('/api/session').set('Cookie',c).expect(200);
    await request(app).get('/api/session').set('Cookie',c).expect(200);
    assert.equal(refreshCount,1);
  });
  await t.test('CSRF and Origin rejected, valid logout destroys local session', async () => {
    const c=await createSession();
    await request(app).post('/api/logout').set('Cookie',c).set('Origin','https://evil.example').set('X-CSRF-Token','csrf-test').expect(403);
    await request(app).post('/api/logout').set('Cookie',c).set('Origin','http://localhost:5173').expect(403);
    const r = await request(app).post('/api/logout').set('Cookie',c).set('Origin','http://localhost:5173').set('X-CSRF-Token','csrf-test').expect(200);
    assert.ok(r.body.logoutUrl.startsWith(`${issuer}/logout`));
    await request(app).get('/api/session').set('Cookie',c).expect(401);
  });
});

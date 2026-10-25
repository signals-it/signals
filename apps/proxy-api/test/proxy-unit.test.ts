import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, createRegistry, defaultRules } from '../src/proxy/registry.js';
import { validateProxyRequest, blockedRequestHeaders } from '../src/proxy/validator.js';
import { filterResponseHeaders } from '../src/proxy/response.js';
import { forwardToBackend } from '../src/proxy/forwarder.js';

test('normalizePath accepts safe backend paths and rejects traversal', () => {
  assert.equal(normalizePath('/signals/api/v1/hosts'), '/signals/api/v1/hosts');
  assert.equal(normalizePath('/a?b=c'), '/a?b=c');
  assert.equal(normalizePath('//evil.example/x'), null);
  assert.equal(normalizePath('https://evil.example/x'), null);
  assert.equal(normalizePath('/signals/../../etc/passwd'), null);
  assert.equal(normalizePath('/signals/%2e%2e/secret'), null);
  assert.equal(normalizePath('/signals/%2f..%2f'), null);
  assert.equal(normalizePath('/signals\\..\\secret'), null);
  assert.equal(normalizePath('relative/path'), null);
  assert.equal(normalizePath(42), null);
});

test('registry permits only allowlisted path patterns and methods and resolves against the backend base', () => {
  const registry = createRegistry(defaultRules, 'https://backend.internal/');
  assert.ok(registry.allows('GET', '/signals/api/v1/hosts'));
  assert.ok(registry.allows('POST', '/signals/api/v1/hosts/abc/ack'));
  assert.equal(registry.allows('GET', '/internal/secrets'), false);
  assert.equal(registry.resolve('GET', '/internal/secrets'), null);
  const target = registry.resolve('GET', '/signals/api/v1/hosts');
  assert.equal(target?.href, 'https://backend.internal/signals/api/v1/hosts');
});

test('registry supports a base URL with a path prefix', () => {
  const registry = createRegistry([{ pattern: '/things/*', methods: ['GET'] }], 'https://backend.internal/root/');
  assert.equal(registry.resolve('GET', '/things/1')?.href, 'https://backend.internal/root/things/1');
});

const options = { allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedRequestHeaders: ['content-type', 'x-correlation-id'] };

test('validator rejects disallowed methods, bad paths and blocked headers', () => {
  const trace = validateProxyRequest({ method: 'TRACE', path: '/signals/api/v1/x' }, options);
  assert.equal(trace.ok, false);
  assert.equal(trace.ok === false && trace.status, 400);

  const traversal = validateProxyRequest({ method: 'GET', path: '/signals/../../etc' }, options);
  assert.equal(traversal.ok === false && traversal.status, 400);

  const blocked = validateProxyRequest({ method: 'GET', path: '/signals/api/v1/x', headers: { Authorization: 'Bearer attacker' } }, options);
  assert.equal(blocked.ok === false && blocked.status, 403);

  assert.ok(blockedRequestHeaders.has('authorization'));
  assert.ok(blockedRequestHeaders.has('cookie'));
  assert.ok(blockedRequestHeaders.has('host'));
});

test('validator strips non-allowlisted headers and drops payloads on body-less methods', () => {
  const result = validateProxyRequest({
    method: 'GET', path: '/signals/api/v1/x', payload: { ignored: true },
    headers: { 'X-Correlation-Id': 'abc', 'X-Secret': 'nope', 'Content-Type': 'application/json' },
    queryParams: { page: 2, enabled: true },
  }, options);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.request.headers, { 'x-correlation-id': 'abc', 'content-type': 'application/json' });
  assert.equal(result.request.payload, undefined);
  assert.deepEqual(result.request.queryParams, { page: '2', enabled: 'true' });

  const post = validateProxyRequest({ method: 'POST', path: '/signals/api/v1/x', payload: { a: 1 } }, options);
  assert.ok(post.ok && post.request.payload !== undefined);
});

test('response header filter forwards only allowlisted headers', () => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Request-Id': 'r1', 'Set-Cookie': 'session=leak' });
  const filtered = filterResponseHeaders(headers, ['content-type', 'x-request-id']);
  assert.deepEqual(filtered, { 'content-type': 'application/json', 'x-request-id': 'r1' });
});

test('forwarder injects the bearer token and retries idempotent calls but not POST', async () => {
  const request = { method: 'GET', path: '/signals/api/v1/hosts', queryParams: { page: '1' }, headers: {}, payload: undefined };
  const calls: { url: string; auth: string | null; cookie: string | null }[] = [];
  let attempt = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    attempt++;
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get('authorization'),
      cookie: new Headers(init?.headers).get('cookie'),
    });
    if (attempt === 1) return new Response('down', { status: 502 });
    return Response.json({ ok: true }, { headers: { 'content-type': 'application/json', 'x-request-id': 'r1' } });
  }) as unknown as typeof fetch;

  const target = new URL('https://backend.internal/signals/api/v1/hosts');
  const result = await forwardToBackend(target, request, { accessToken: 'opaque', timeoutMs: 1000, correlationId: 'corr', fetchImpl });
  assert.ok(result.ok);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, 'Bearer opaque');
  assert.equal(calls[0].cookie, null);
  assert.match(calls[0].url, /page=1/);

  let postCalls = 0;
  const postFetch = (async () => { postCalls++; return new Response('down', { status: 502 }); }) as unknown as typeof fetch;
  const post = await forwardToBackend(target, { ...request, method: 'POST', payload: { a: 1 } }, { accessToken: 't', timeoutMs: 1000, correlationId: 'c', fetchImpl: postFetch });
  assert.ok(post.ok && post.status === 502); // Backend status is forwarded; POST is not retried.
  assert.equal(postCalls, 1);
});

test('forwarder reports a timeout distinctly', async () => {
  const timeoutFetch = (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
  const result = await forwardToBackend(new URL('https://backend.internal/x'), { method: 'GET', path: '/x', queryParams: {}, headers: {} },
    { accessToken: 't', timeoutMs: 5, correlationId: 'c', fetchImpl: timeoutFetch });
  assert.deepEqual(result, { ok: false, kind: 'timeout' });
});

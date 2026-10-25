import type { ProxyRequest } from './validator.js';

export type ForwardResult =
  | { ok: true; status: number; headers: Headers; body: unknown }
  | { ok: false; kind: 'timeout' | 'network' };

export interface ForwardOptions {
  accessToken: string;
  timeoutMs: number;
  correlationId: string;
  /** Opaque server-side session id forwarded to the backend over the internal network. */
  internalSessionId?: string;
  /** Shared secret proving the request came from the authenticated proxy. */
  internalToken?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
}

const idempotent = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try { return await response.json(); } catch { return null; }
  }
  const text = await response.text();
  return text.length ? text : null;
}

/**
 * Execute the outbound backend request. The Authorization header is always set
 * here from the caller's session and can never be overridden. Only idempotent
 * methods are retried so POST/PATCH cannot be duplicated.
 */
export async function forwardToBackend(target: URL, request: ProxyRequest, options: ForwardOptions): Promise<ForwardResult> {
  const url = new URL(target);
  for (const [key, value] of Object.entries(request.queryParams)) url.searchParams.append(key, value);
  const headers: Record<string, string> = {
    ...request.headers,
    authorization: `Bearer ${options.accessToken}`,
    'x-correlation-id': options.correlationId,
  };
  if (options.internalSessionId) headers['x-signals-session'] = options.internalSessionId;
  if (options.internalToken) headers['x-signals-internal-token'] = options.internalToken;
  const hasBody = request.payload !== undefined && bodyMethods.has(request.method);
  if (hasBody && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  const init: RequestInit = { method: request.method, headers };
  if (hasBody) init.body = JSON.stringify(request.payload);

  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = idempotent.has(request.method) ? (options.retries ?? 1) + 1 : 1;
  let failure: 'timeout' | 'network' = 'network';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
      if (response.status === 502 && attempt + 1 < attempts) { failure = 'network'; continue; }
      return { ok: true, status: response.status, headers: response.headers, body: await readBody(response) };
    } catch (error) {
      failure = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
    }
  }
  return { ok: false, kind: failure };
}

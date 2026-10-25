import { normalizePath } from './registry.js';

export interface ProxyRequest {
  method: string;
  path: string;
  queryParams: Record<string, string>;
  payload?: unknown;
  headers: Record<string, string>;
}

export interface ValidationOptions {
  allowedMethods: string[];
  allowedRequestHeaders: string[];
}

export type ValidationResult =
  | { ok: true; request: ProxyRequest }
  | { ok: false; status: number; field?: string; error: string };

/** Security-sensitive request headers that are never forwarded, regardless of the allowlist. */
export const blockedRequestHeaders = new Set([
  'authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding',
  'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'expect',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded',
  'x-signals-session', 'x-signals-internal-token',
]);

const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(status: number, error: string, field?: string): ValidationResult {
  return { ok: false, status, field, error };
}

/**
 * Validate the centralized proxy request schema. Returns a normalised request
 * or an HTTP status describing why it was rejected. Blocked headers are an
 * explicit 403; headers outside the allowlist are silently dropped.
 */
export function validateProxyRequest(body: unknown, options: ValidationOptions): ValidationResult {
  if (!isPlainObject(body)) return fail(400, 'Proxy request body must be a JSON object');
  const allowedMethods = new Set(options.allowedMethods.map(method => method.toUpperCase()));
  const allowedHeaders = new Set(options.allowedRequestHeaders.map(header => header.toLowerCase()));

  if (typeof body.method !== 'string') return fail(400, 'method is required', 'method');
  const method = body.method.toUpperCase();
  if (!allowedMethods.has(method)) return fail(400, `Method '${body.method}' is not permitted`, 'method');

  const path = normalizePath(body.path);
  if (!path) return fail(400, 'path is missing, invalid or contains traversal', 'path');

  const queryParams: Record<string, string> = {};
  if (body.queryParams !== undefined) {
    if (!isPlainObject(body.queryParams)) return fail(400, 'queryParams must be an object', 'queryParams');
    for (const [key, value] of Object.entries(body.queryParams)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        queryParams[key] = String(value);
      } else {
        return fail(400, `queryParams.${key} must be a scalar value`, 'queryParams');
      }
    }
  }

  const headers: Record<string, string> = {};
  if (body.headers !== undefined) {
    if (!isPlainObject(body.headers)) return fail(400, 'headers must be an object', 'headers');
    for (const [key, value] of Object.entries(body.headers)) {
      const lower = key.toLowerCase();
      if (blockedRequestHeaders.has(lower)) return fail(403, `Header '${key}' is not permitted`, 'headers');
      if (typeof value !== 'string') return fail(400, `headers.${key} must be a string`, 'headers');
      if (allowedHeaders.has(lower)) headers[lower] = value;
    }
  }

  const payload = bodyMethods.has(method) ? body.payload : undefined;
  return { ok: true, request: { method, path, queryParams, payload, headers } };
}

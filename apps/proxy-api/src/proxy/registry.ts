import { readFileSync } from 'node:fs';

export type OperationRule = { pattern: string; methods: string[] };

/**
 * Default backend operation registry. Paths must be explicitly permitted;
 * arbitrary URLs are never accepted. Override with PROXY_REGISTRY_PATH.
 */
export const defaultRules: OperationRule[] = [
  { pattern: '/signals/api/v1/*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
];

export function loadRules(path?: string): OperationRule[] {
  if (!path) return defaultRules;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { operations?: unknown };
  if (!Array.isArray(parsed.operations)) throw new Error('Proxy registry must contain an "operations" array');
  return parsed.operations.map(rule => {
    const entry = rule as { pattern?: unknown; methods?: unknown };
    if (typeof entry.pattern !== 'string' || !entry.pattern.startsWith('/')) {
      throw new Error('Proxy registry operation pattern must start with "/"');
    }
    const methods = Array.isArray(entry.methods) ? entry.methods.map(method => String(method).toUpperCase()) : [];
    if (methods.length === 0) throw new Error(`Proxy registry operation ${entry.pattern} has no methods`);
    return { pattern: entry.pattern, methods };
  });
}

/**
 * Validate and canonicalise a caller-supplied backend path. Rejects absolute
 * URLs, protocol-relative values, traversal segments and encoded separators so
 * the proxy cannot be redirected away from the configured backend base URL.
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (raw[0] !== '/' || raw.startsWith('//')) return null;
  if (raw.includes('\\') || raw.includes('\0')) return null;
  if (/%(2e|2f|5c)/i.test(raw)) return null;
  for (const segment of raw.split('/')) {
    if (segment === '..' || segment === '.') return null;
  }
  return raw;
}

export interface ProxyRegistry {
  allows(method: string, path: string): boolean;
  resolve(method: string, path: string): URL | null;
}

export function createRegistry(rules: OperationRule[], backendBaseUrl: string): ProxyRegistry {
  const matches: { prefix: string | null; exact: string | null; methods: Set<string> }[] = rules.map(rule => ({
    prefix: rule.pattern.endsWith('*') ? rule.pattern.slice(0, -1) : null,
    exact: rule.pattern.endsWith('*') ? null : rule.pattern,
    methods: new Set(rule.methods),
  }));
  return {
    allows(method, path) {
      const upper = method.toUpperCase();
      return matches.some(rule => rule.methods.has(upper)
        && (rule.exact === path || (rule.prefix !== null && path.startsWith(rule.prefix))));
    },
    resolve(method, path) {
      if (!backendBaseUrl || !this.allows(method, path)) return null;
      const base = new URL(backendBaseUrl);
      base.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
      return base;
    },
  };
}

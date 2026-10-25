export function filterResponseHeaders(headers: Headers, allowlist: string[]): Record<string, string> {
  const allowed = new Set(allowlist.map(header => header.toLowerCase()));
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (allowed.has(key.toLowerCase())) result[key] = value;
  });
  return result;
}

import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function seal(data: unknown, key: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function open<T>(value: string, key: Buffer): T {
  const b = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
}
export const permissions: Record<string, readonly string[]> = {
  tenant_admin: ['integrations:read', 'administration:read'],
  operator: ['integrations:read'],
  viewer: ['integrations:read'],
};
export const can = (role: string, permission: string) => permissions[role]?.includes(permission) ?? false;

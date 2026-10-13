import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal,open,equal,can } from '../src/security.js';
test('encrypted token payload rejects tampering and wrong key', () => {
  const key=randomBytes(32), value=seal({refresh_token:'secret'},key);
  assert.deepEqual(open(value,key),{refresh_token:'secret'});
  assert.throws(() => open(value,randomBytes(32)));
  const b=Buffer.from(value,'base64'); b[b.length-1]^=1;
  assert.throws(() => open(b.toString('base64'),key));
});
test('permission and CSRF checks fail closed', () => {
  assert.equal(can('viewer','administration:read'),false);
  assert.equal(can('unknown','integrations:read'),false);
  assert.equal(equal(undefined,'token'),false);
  assert.equal(equal('token','other'),false);
  assert.equal(equal('token','token'),true);
});

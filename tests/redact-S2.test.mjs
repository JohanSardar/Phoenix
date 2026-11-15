import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets } from '../packages/redact/src/index.ts';

test('S2: stripping a form secret preserves the other form fields', async () => {
  const result = await stripSecrets(
    { body: Buffer.from('password=private-value&username=alice&scope=read'),
      contentType: 'application/x-www-form-urlencoded' },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  const form = new URLSearchParams(Buffer.from(result.msg.body).toString());
  assert.equal(form.get('username'), 'alice', 'non-secret username was deleted');
  assert.equal(form.get('scope'), 'read');
  assert.notEqual(form.get('password'), 'private-value');
});

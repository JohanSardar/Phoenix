import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets } from '../packages/redact/src/index.ts';

test('S8: JSON-fragment scanning preserves enclosing secret-assignment stripping', async () => {
  const result = await stripSecrets(
    { contentType: 'text/plain',
      body: Buffer.from('credentials={"value":"private-value"}\nkeep=ok') },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  const body = Buffer.from(result.msg.body).toString();
  assert.equal(body.includes('private-value'), false,
    'recognizing a JSON fragment must not expose an enclosing credentials value');
  assert.notEqual(result.msg.secrets, 'unscanned');
  assert.match(body, /\nkeep=ok$/);
});

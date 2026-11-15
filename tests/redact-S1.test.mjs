import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets } from '../packages/redact/src/index.ts';

test('S1: capture strips secret-named values in assembled SSE bodies', async () => {
  const body = 'data: {"api_key":"private-value","ok":true}\n\n';
  const result = await stripSecrets(
    { body: Buffer.from(body), contentType: 'text/event-stream' },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  assert.equal(Buffer.from(result.msg.body).toString().includes('private-value'), false,
    'a readable SSE secret must not be returned as scanned plaintext');
  assert.notEqual(result.msg.secrets, 'unscanned');
  assert.match(Buffer.from(result.msg.body).toString(), /"ok":true/);
});

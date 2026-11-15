import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets } from '../packages/redact/src/index.ts';

test('S7: stripping URL credentials preserves the URL outside userinfo', async () => {
  const result = await stripSecrets(
    { url: 'https://user:pass@host.test/path?ok=1' },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  let url;
  assert.doesNotThrow(() => { url = new URL(result.msg.url); },
    `redaction destroyed the URL: ${result.msg.url}`);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'host.test');
  assert.equal(url.pathname, '/path');
  assert.equal(url.searchParams.get('ok'), '1');
  assert.ok(!result.msg.url.includes('user:pass'));
});

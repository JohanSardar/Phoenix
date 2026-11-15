import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubPersonalData } from '../packages/redact/src/index.ts';

test('S3: pack scrubs a percent-encoded email using the same mapping as JSON', async () => {
  const result = await scrubPersonalData(
    { url: 'https://example.test/?email=rebecca.stone%40orchid-labs.net&limit=10',
      body: Buffer.from('{"email":"rebecca.stone@orchid-labs.net"}'), contentType: 'application/json' },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  const url = new URL(result.msg.url);
  const { email } = JSON.parse(Buffer.from(result.msg.body).toString());
  assert.match(email, /^\[personal:/);
  assert.equal(url.searchParams.get('email'), email,
    'the URL still contains the original email instead of the pack placeholder');
  assert.equal(url.searchParams.get('limit'), '10');
});

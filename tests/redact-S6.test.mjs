import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubPersonalData } from '../packages/redact/src/index.ts';

test('S6: packing scrubs personal data used as a JSON object key', async () => {
  const result = await scrubPersonalData(
    { body: Buffer.from('{"owner":"rebecca.stone@orchid-labs.net","contacts":{"rebecca.stone@orchid-labs.net":{"active":true}}}'),
      contentType: 'application/json' },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  const body = Buffer.from(result.msg.body).toString();
  assert.match(JSON.parse(body).owner, /^\[personal:/);
  assert.equal(body.includes('rebecca.stone@orchid-labs.net'), false,
    'an email used as a map key is still personal data');
  const contacts = JSON.parse(body).contacts;
  assert.equal(Object.values(contacts)[0].active, true);
});

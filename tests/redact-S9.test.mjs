import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets, scrubPersonalData } from '../packages/redact/src/index.ts';

test('S9: malformed form encoding remains capturable instead of rejecting', async () => {
  const body = Buffer.from('comment=100%&password=private-value');
  const policy = { hmacKey: Buffer.alloc(32, 7) };
  let result;
  await assert.doesNotReject(async () => {
    result = await stripSecrets({ body, contentType: 'application/x-www-form-urlencoded' }, policy);
  }, 'undecodable wire data must return evidence, not throw');
  if (result.msg.secrets === 'unscanned') {
    assert.deepEqual(result.msg.body, body);
    const packed = await scrubPersonalData(result.msg, policy);
    assert.equal(packed.msg.body, undefined);
    assert.equal(packed.withheld.size, body.length);
  } else {
    assert.equal(Buffer.from(result.msg.body).toString().includes('private-value'), false);
  }
});

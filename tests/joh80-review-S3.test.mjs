import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('JOH-80 S3: command must not bypass a plugin-owned command', async t => {
  const result = await shellCase(t, 'command mailer envelope list');
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.copyCalls === 1 || result.observed.denied !== undefined,
    'Route to the plugin copy, or fall through without running the plugin command in the harness box');
});

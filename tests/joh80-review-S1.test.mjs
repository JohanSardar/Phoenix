import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('JOH-80 S1: cd into a child permits a parent-relative read inside the copy', async t => {
  const result = await shellCase(t, 'cd child && cat ../value.txt');
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.observed.stdout, 'FILES-COPY\n');
});

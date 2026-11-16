import test from 'node:test';
import assert from 'node:assert/strict';
import { forkCommand } from './joh52-helpers.mjs';

test('S2: a recorded command in a subdirectory reaches the stand-in', async t => {
  const result = await forkCommand(t, { workdir: '/synthetic-project/src' });
  assert.equal(result.toolCalls, 1, 'The recorded workdir must exist in the box so Codex can reach the shell stand-in');
  assert.equal(result.executed, false);
  assert.match(result.observed, /recorded-result/);
});

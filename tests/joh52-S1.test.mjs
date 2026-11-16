import test from 'node:test';
import assert from 'node:assert/strict';
import { forkCommand } from './joh52-helpers.mjs';

test('S1: an explicitly selected shell still gets its recorded result from Phoenix', async t => {
  const result = await forkCommand(t, { shell: '/bin/bash' });
  assert.equal(result.toolCalls, 1, 'The recorded shell call must reach Phoenix even when Codex specifies /bin/bash');
  assert.equal(result.executed, false, 'A replay must not execute the recorded command for real');
  assert.match(result.observed, /recorded-result/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { runsOnCopy } from '../packages/engine/src/shell-on-copy.ts';

test('JOH-80 S2: shell options before -c must not hide network commands', () => {
  const command = "bash -e -c 'curl https://example.invalid/data'";
  const authorized = runsOnCopy(command, '/project');
  console.log(JSON.stringify({ command, authorized }));
  assert.equal(authorized, false);
});

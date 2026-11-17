import assert from 'node:assert/strict';
import test from 'node:test';
import { runsOnCopy } from '../packages/engine/src/shell-on-copy.ts';

test('JOH-80 S5: cd must not authorize execution outside the files copy', () => {
  const command = "cd /tmp && pwd";
  const authorized = runsOnCopy(command, '/project');
  console.log(JSON.stringify({ command, authorized }));
  assert.equal(authorized, false);
});

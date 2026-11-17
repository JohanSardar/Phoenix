import assert from 'node:assert/strict';
import test from 'node:test';
import { runsOnCopy } from '../packages/engine/src/shell-on-copy.ts';

test('JOH-80 S6: the default yarn install must not run on the files copy', () => {
  const command = "yarn";
  const authorized = runsOnCopy(command, '/project');
  console.log(JSON.stringify({ command, authorized }));
  assert.equal(authorized, false);
});

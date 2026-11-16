import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, finishedReplay } from './workbench-review-helpers.mjs';

test('S2: disagreeing intent judgments must schedule the locked tiebreak sample', async t => {
  const f = await fixture(t, { phoenix_check: 1, samples: { base: 2, tiebreak: 1 }, scope: 'run',
    expect: [{ max_calls: { tool: '*', count: 1 } }], intent: 'Repair the task.' });
  const replay = await finishedReplay(f, ['unassessed', 'unassessed']);
  await f.api.judgeIntent(replay.id, 0, true, 'The first sample repaired the task.');
  await f.api.judgeIntent(replay.id, 1, false, 'The second sample did not repair the task.');
  const checks = await f.api.runChecks(replay.setId);
  assert.equal(checks.moments[0].scheduled, 3);
  assert.equal((await f.api.startReplay()).replay, replay.setId);
  const progress = await f.api.getReplay(replay.setId);
  assert.equal(progress.done, false,
    `done=${progress.done}, samples=${progress.moments[0].candidate.samples.length}, required=${checks.moments[0].scheduled}, note=${checks.moments[0].note}`);
});

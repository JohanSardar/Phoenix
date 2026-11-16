import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Runner } from '../packages/runner/src/index.ts';
import { fixture, finishedReplay } from './workbench-review-helpers.mjs';

test('S4: polling must wait for a re-judged baseline before reporting done', async t => {
  const f = await fixture(t, { phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: 'run',
    expect: [{ max_calls: { tool: '*', count: 1 } }], intent: 'Repair the task.' });
  const replay = await finishedReplay(f, ['unassessed']);
  const baseline = (await f.api.getReplay(replay.setId)).moments[0].baseline.replay;
  await f.api.judgeIntent(replay.id, 0, true, 'The candidate repaired the task.');
  const runner = new Runner({ root: f.home, ledger: join(f.home, 'approvals.jsonl') });
  await runner.resume(replay.id);
  assert.equal((await runner.status(replay.id)).state, 'finished');
  await f.api.judgeIntent(baseline, 0, false, 'The baseline did not repair the task.');
  assert.equal((await f.api.runChecks(replay.setId)).complete, false);
  const progress = await f.api.getReplay(replay.setId);
  assert.equal(progress.done, false,
    `candidate=${progress.moments[0].candidate.state}, baseline=${progress.moments[0].baseline.state}, baseline_running=${progress.moments[0].baseline.running}`);
});

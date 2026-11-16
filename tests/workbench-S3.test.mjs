import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptPass, reviewPass } from '../packages/approvals/src/index.ts';
import { evaluateCheck } from '../packages/checks/src/index.ts';
import { fixture, finishedReplay } from './workbench-review-helpers.mjs';

test('S3: a person-accepted discounted pass must count in patch results', async t => {
  const f = await fixture(t, { phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: 'run',
    expect: [{ max_calls: { tool: '*', count: 1 } }] });
  const synthesized = { v: 1, capture: 'fixture', stream: 'tool', seq: 0, kind: 'result',
    ts: { wall: '2026-11-15T12:00:00Z' }, connector: 'fixture', surface: 'mcp', provenance: 'synthesized',
    body: { inline: '{"answer":"derived by simulator"}' } };
  const assessment = await evaluateCheck(f.check, { trace: [synthesized] });
  assert.equal(assessment.expectations[0].tainted, true);
  const replay = await finishedReplay(f, ['pass'], { discounted: true, assessment });
  assert.equal((await f.api.runChecks(replay.setId)).moments[0].counts_toward_patch, false);
  const trace = join(f.root, 'trace.jsonl');
  await writeFile(trace, JSON.stringify(synthesized) + '\n');
  const review = await reviewPass(replay.resultPath, [trace], 'm', f.home);
  await acceptPass(replay.resultPath, { traces: [trace], moment: 'm', home: f.home, who: 'person', reviewed: review.hash });
  const reopened = await f.api.constructor.open({ home: f.home, workspace: 'review' });
  const patch = await reopened.makePatch();
  const result = JSON.parse(await readFile(patch.result, 'utf8'));
  assert.deepEqual({ discount: result.moments[0].discount, claims: result.claims },
    { discount: { discounted: true, confirmed: 'pass-accepted' }, claims: ['m'] },
    'The pass-accepted entry for this exact result must be consumed without giving Workbench a ledger writer');
});

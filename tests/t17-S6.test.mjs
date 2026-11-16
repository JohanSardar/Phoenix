import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox, cli, event, catalog, record, model } from './t17-helpers.mjs';

test('S6: check draft respects the Correction selected by moment create', async t => {
  const root = await sandbox(t);
  const capture = await record(root, [
    ...catalog(),
    event(5, 'correction', { at: 'event-4' }, 'Say the first answer.'),
    event(6, 'correction', { at: 'event-4' }, 'Say the replacement answer.'),
  ]);
  const out = join(root, 'moment');
  const created = await cli('moment', ['create', '--auto', '--capture', capture, '--mark', 'event-4', '--correction', 'event-6', '--id', 'review', out]);
  assert.equal(created.status, 0, created.stderr);
  const options = await model(t, { phoenix_check: 1, scope: 'continuation', intent: 'Say the replacement answer.', expect: [{ final_text: { contains: 'replacement answer' } }] });
  const result = await cli('check', ['draft', ...options, out]);
  assert.equal(result.status, 0, result.stderr);
});

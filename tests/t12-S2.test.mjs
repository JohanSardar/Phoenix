import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCheck, sampleVerdict } from '../packages/checks/src/index.ts';

test('S2: an unrelated CLI call cannot erase an untapped model tool action', async () => {
  const event = (seq, values) => ({
    v: 1, capture: 'mixed-tools', stream: `stream-${seq}`, seq: 0, id: `stream-${seq}:0`,
    ts: { wall: '2026-11-15T12:00:00Z', mono: String(seq) }, layer: 'agent', ...values,
  });
  const trace = [
    event(1, { kind: 'result', surface: 'http', connector: 'model', op: 'POST /v1/chat/completions', body: { inline: JSON.stringify({
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'email-1', type: 'function', function: {
        name: 'send_email', arguments: JSON.stringify({ to: 'attendees@example.test', body: 'The meeting moved.' }),
      } }] } }],
    }) } }),
    event(2, { kind: 'call', surface: 'cli', connector: 'clock', op: 'date', body: { inline: JSON.stringify({
      argv: ['date', '+%F'], cwd: '/work', env: {}, terminals: { stdin: null, stdout: null, stderr: null },
    }) } }),
  ];
  const assessed = await evaluateCheck({ phoenix_check: 1, samples: { base: 2, tiebreak: 1 }, scope: 'run', expect: [{ not_called: { tool: 'send_email' } }] }, { trace });
  assert.equal(sampleVerdict(assessed).status, 'fail',
    `The untapped send_email action must survive; actions=${JSON.stringify(assessed.evidence.actions)}; notes=${JSON.stringify(assessed.evidence.notes)}`);
});

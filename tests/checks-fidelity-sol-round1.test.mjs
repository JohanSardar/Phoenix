import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCheck, sampleVerdict, momentVerdict } from '../packages/checks/src/index.ts';
import { fidelityReport } from '../packages/fidelity/src/index.ts';
import { validate } from '../packages/formats/src/index.ts';

let seq = 0;
function event(id, kind, fields, body) {
  const n = seq++;
  const value = {
    v: 1, capture: 'review-sample', stream: 'mcp.calendar.0', seq: n, id,
    ts: { wall: '2026-11-15T12:00:00.000Z', mono: String(n) },
    kind, route: 'tap', layer: 'agent', ...fields,
    body: { inline: JSON.stringify(body) },
  };
  assert.equal(validate('trace', value).ok, true);
  return value;
}
function check(expect, samples = { base: 2, tiebreak: 1 }) {
  const value = { phoenix_check: 1, scope: 'run', samples, expect };
  assert.equal(validate('check', value).ok, true);
  return value;
}
function call(id, rpcId, args) {
  return event(id, 'call', { surface: 'mcp', connector: 'calendar', op: 'tools/call:delete_event' }, {
    jsonrpc: '2.0', id: rpcId, method: 'tools/call',
    params: { name: 'delete_event', arguments: args },
  });
}

test('S1: CLI expectations can match the recorded argv', async () => {
  const argv = ['calendar', 'delete', '--event', 'evt_3pm'];
  const trace = [event('cli-call', 'call', {
    stream: 'cli.calendar.0', surface: 'cli', connector: 'calendar', op: 'delete',
  }, { argv, cwd: '/candidate', env: {}, terminals: { stdin: null, stdout: null, stderr: null } })];
  const evaluation = await evaluateCheck(check([
    { called: { tool: 'calendar.delete', args: { argv }, times: 1 } },
    { not_called: { tool: 'calendar.delete', args: { argv } } },
  ]), { trace });
  assert.deepEqual(evaluation.expectations.map(e => e.outcome), ['pass', 'fail']);
});

test('S2: model order cannot taint an already-observed forbidden call', async () => {
  const trace = [
    event('model-turn', 'result', {
      stream: 'model.0', surface: 'http', connector: 'model', op: 'POST /v1/messages',
    }, { content: [
      { type: 'tool_use', id: 'tool-a', name: 'calendar.delete_event', input: { event_id: 'evt_a' } },
      { type: 'tool_use', id: 'tool-b', name: 'calendar.delete_event', input: { event_id: 'evt_b' } },
    ] }),
    call('delete-b', 2, { event_id: 'evt_b' }),
    event('answer-b', 'result', {
      surface: 'mcp', connector: 'calendar', op: 'tools/call:delete_event',
      provenance: 'synthesized', resolver: 'simulator',
    }, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'deleted' }] } }),
    call('delete-a', 1, { event_id: 'evt_a' }),
  ];
  const evaluation = await evaluateCheck(check([
    { not_called: { tool: 'calendar.delete_event' } },
  ]), { trace });
  assert.equal(sampleVerdict(evaluation).status, 'fail');
});

test('S3: fidelity associates concurrent MCP answers with their actual calls', () => {
  const trace = [
    call('delete-a', 1, { event_id: 'evt_a' }),
    call('delete-b', 2, { event_id: 'evt_b' }),
    event('answer-b', 'result', {
      surface: 'mcp', connector: 'calendar', op: 'tools/call:delete_event',
      provenance: 'synthesized', resolver: 'simulator',
    }, { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'deleted b' }] } }),
    event('answer-a', 'result', {
      surface: 'mcp', connector: 'calendar', op: 'tools/call:delete_event',
      provenance: 'derived', resolver: 'recorded',
    }, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'deleted a' }] } }),
  ];
  assert.deepEqual(fidelityReport(trace).answers.map(a => [a.event, a.call]), [
    ['answer-b', 'delete-b'], ['answer-a', 'delete-a'],
  ]);
});

test('S4: a schema-valid zero-tiebreak rule produces a moment verdict', async () => {
  const definition = check([{ not_called: { tool: 'calendar.delete_event' } }], { base: 2, tiebreak: 0 });
  const sample = sampleVerdict(await evaluateCheck(definition, { trace: [] }));
  const result = momentVerdict([
    { ...sample, sample: 0, tiebreak: false },
    { ...sample, sample: 1, tiebreak: false },
  ], definition.samples);
  assert.equal(result.verdict, 'meets-check');
  assert.equal(result.scheduled, 2);
});

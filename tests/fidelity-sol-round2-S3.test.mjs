import assert from 'node:assert/strict';
import test from 'node:test';
import { fidelityReport } from '../packages/fidelity/src/index.ts';
import { validate } from '../packages/formats/src/index.ts';

test('S3: MCP Streamable HTTP SSE answers retain their call reference', () => {
  const response = {
    jsonrpc: '2.0', id: 7,
    result: { content: [{ type: 'text', text: 'Moved evt_3pm to 16:00.' }] },
  };
  const trace = [
    {
      v: 1, capture: 'sample', stream: 'mcp.calendar.http.0', seq: 0,
      ts: { wall: '2026-11-15T12:00:00.000Z', mono: '0' },
      id: 'move-call', kind: 'call', route: 'tap', surface: 'mcp', layer: 'agent',
      connector: 'calendar', op: 'tools/call:move_event',
      body: { inline: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'move_event', arguments: { event_id: 'evt_3pm', start: '16:00' } },
      }) },
    },
    {
      v: 1, capture: 'sample', stream: 'mcp.calendar.http.0', seq: 1,
      ts: { wall: '2026-11-15T12:00:01.000Z', mono: '1' },
      id: 'move-answer', kind: 'result', route: 'tap', surface: 'mcp', layer: 'agent',
      connector: 'calendar', op: 'tools/call:move_event',
      provenance: 'derived', resolver: 'recorded',
      body: { inline: `event: message\ndata: ${JSON.stringify(response)}\n\n` },
    },
  ];
  for (const event of trace) assert.equal(validate('trace', event).ok, true);
  assert.deepEqual(fidelityReport(trace).answers.map(a => [a.event, a.call]), [
    ['move-answer', 'move-call'],
  ]);
});

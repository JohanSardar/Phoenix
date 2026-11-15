import assert from 'node:assert/strict';
import test from 'node:test';
import { fidelityReport } from '../packages/fidelity/src/index.ts';
import { validate } from '../packages/formats/src/index.ts';
import { decodeMcpHttp } from '../packages/wire/src/index.ts';

test('S3: resumable MCP SSE starting with an event ID retains the call', () => {
  const request = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'move_event', arguments: { event_id: 'evt_3pm', start: '16:00' },
  } };
  const response = { jsonrpc: '2.0', id: 7, result: {
    content: [{ type: 'text', text: 'Moved evt_3pm to 16:00.' }],
  } };
  const sse = `id: calendar-stream-7\nevent: message\ndata: ${JSON.stringify(response)}\n\n`;
  assert.equal(decodeMcpHttp(new TextEncoder().encode(sse), 'text/event-stream')[0].ok, true);
  const trace = [
    { id: 'move-call', kind: 'call', body: { inline: JSON.stringify(request) } },
    { id: 'move-answer', kind: 'result', provenance: 'derived', resolver: 'recorded', body: { inline: sse } },
  ].map((event, seq) => ({
    v: 1, capture: 'sample', stream: 'mcp.calendar.http.0', seq,
    ts: { wall: '2026-11-15T12:00:00.000Z', mono: String(seq) },
    route: 'tap', surface: 'mcp', layer: 'agent', connector: 'calendar',
    op: 'tools/call:move_event', ...event,
  }));
  for (const event of trace) assert.equal(validate('trace', event).ok, true);
  assert.equal(fidelityReport(trace).answers[0].call, 'move-call');
});

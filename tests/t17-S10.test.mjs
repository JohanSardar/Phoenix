import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox, cli, event, catalog, record } from './t17-helpers.mjs';

test('S10: an absent transcript result body stays missing instead of becoming an empty answer', async t => {
  const root = await sandbox(t);
  const mcp = { surface: 'mcp', layer: 'agent', connector: 'calendar', op: 'tools/call:list_events' };
  const capture = await record(root, [
    ...catalog([{ name: 'list_events', inputSchema: { type: 'object' } }]),
    event(5, 'call', mcp, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_events', arguments: {} } }),
    event(6, 'result', { ...mcp, verbatim: [] }),
    event(7, 'correction', { at: 'event-6' }, 'List the events.'),
  ]);
  const result = await cli('moment', ['create', '--auto', '--capture', capture, '--mark', 'event-6', '--id', 'review', join(root, 'moment')]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.fills.some(f => f.item === 'mcp.tools/call.result'), false,
    'setup manufactured a derived empty tool result although the transcript supplied no body');
  assert.ok(summary.missing.some(f => f.item === 'mcp.tools/call.result'));
});

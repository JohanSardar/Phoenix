import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, cli, event, catalog, draft, model } from './t17-helpers.mjs';

test('S5: a correction may require an available tool that the failed run never called', async t => {
  const root = await sandbox(t);
  const tools = ['delete_event', 'move_event'].map(name => ({ name, inputSchema: { type: 'object' } }));
  const mcp = { surface: 'mcp', layer: 'agent', connector: 'calendar', op: 'tools/call:delete_event' };
  const path = await draft(root, [
    ...catalog(tools),
    event(5, 'call', mcp, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_event', arguments: {} } }),
    event(6, 'result', mcp, { jsonrpc: '2.0', id: 3, result: { content: [] } }),
    event(7, 'correction', { at: 'event-6' }, 'Move the event instead of deleting it.'),
  ]);
  const options = await model(t, { phoenix_check: 1, scope: 'continuation', intent: 'Move rather than delete.', expect: [
    { called: { tool: 'calendar.move_event', times: 1 } }, { not_called: { tool: 'calendar.delete_event' } },
  ] });
  const result = await cli('check', ['draft', ...options, path]);
  assert.equal(result.status, 0, result.stderr);
});

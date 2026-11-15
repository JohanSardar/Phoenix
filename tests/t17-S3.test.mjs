import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { sandbox, cli, event, catalog, record } from './t17-helpers.mjs';

test('S3: auto setup derives an MCP envelope from a transcript tool result', async t => {
  const root = await sandbox(t);
  const mcp = { surface: 'mcp', layer: 'agent', connector: 'calendar', op: 'tools/call:list_events' };
  const capture = await record(root, [
    ...catalog([{ name: 'list_events', inputSchema: { type: 'object' } }]),
    event(5, 'call', mcp, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_events', arguments: {} } }),
    event(6, 'result', mcp, 'No events found.'),
    event(7, 'correction', { at: 'event-6' }, 'Report that there are no events.'),
  ]);
  const out = join(root, 'moment');
  const result = await cli('moment', ['create', '--auto', '--capture', capture, '--mark', 'event-6', '--id', 'review', out]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const filled = summary.fills.find(f => f.item === 'mcp.tools/call.result');
  assert.ok(filled, `the transcript result was neither filled nor reported missing: ${JSON.stringify(summary.missing)}`);
  const fill = JSON.parse(await readFile(join(out, filled.path), 'utf8'));
  assert.equal(fill.tag, 'derived');
  assert.equal(fill.value.content[0].text, 'No events found.');
});

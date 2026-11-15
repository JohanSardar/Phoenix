import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox, cli, event, catalog, record } from './t17-helpers.mjs';
import { deriveToolList } from '../packages/wire/src/index.ts';

test('S4: auto setup uses the existing mechanical tool-list rule before requiring a model', async t => {
  const root = await sandbox(t);
  const request = { model: 'recorded-model', input: [], tools: [{ type: 'function', name: 'list_events', parameters: { type: 'object' } }] };
  assert.equal(deriveToolList(request, 'responses', { connector: 'calendar', evidence: 'event:event-3' }).ok, true);
  const http = { stream: 'model', surface: 'http', layer: 'agent', connector: 'model', op: 'POST /v1/responses' };
  const capture = await record(root, [
    ...catalog().slice(0, 2),
    event(3, 'call', http, request),
    event(4, 'result', http, { model: 'recorded-model', output: [] }),
    event(5, 'correction', { at: 'event-4' }, 'Use the calendar tool.'),
  ]);
  const result = await cli('moment', ['create', '--auto', '--capture', capture, '--mark', 'event-4', '--id', 'review', join(root, 'moment')]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.missing.some(f => f.item === 'mcp.tools/list.result'), false,
    'a mechanically derivable tool list is still missing without a setup model');
  assert.ok(summary.fills.some(f => f.item === 'mcp.tools/list.result' && f.tag === 'derived' && f.producer.startsWith('wire:')));
});

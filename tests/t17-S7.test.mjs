import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sandbox, cli, event, catalog, record, model } from './t17-helpers.mjs';

test('S7: an agent fill containing an uncited null value is synthesized', async t => {
  const root = await sandbox(t);
  const tools = [{ name: 'list_events', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];
  const doc = join(root, 'tools.json');
  await writeFile(doc, JSON.stringify({ tools }));
  const capture = await record(root, [
    ...catalog().slice(0, 2),
    event(3, 'correction', { at: 'event-2' }, 'List events.'),
  ]);
  const options = await model(t, {
    value: { tools: [{ ...tools[0], inputSchema: { ...tools[0].inputSchema, properties: { query: { type: 'string', default: null } } } }] },
    evidence: [`doc:${doc}`],
  });
  const result = await cli('moment', ['create', '--auto', '--capture', capture, '--mark', 'event-2', '--id', 'review', '--doc', doc, ...options, join(root, 'moment')]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const fill = summary.fills.find(f => f.item === 'mcp.tools/list.result');
  assert.ok(fill);
  assert.equal(fill.tag, 'synthesized', 'null is absent from the cited evidence but is ignored by the mechanical verifier');
});

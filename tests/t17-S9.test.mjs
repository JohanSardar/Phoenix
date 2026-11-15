import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readMomentBundle } from '../packages/store/src/index.ts';
import { sandbox, cli, event, draft, approve } from './t17-helpers.mjs';

test('S9: packing strips secret fields inside JSON-encoded MCP result text', async t => {
  const root = await sandbox(t);
  const sentinel = 'review-sentinel-not-a-real-credential';
  const output = { jsonrpc: '2.0', id: 1, result: { content: [
    { type: 'text', text: JSON.stringify({ api_key: sentinel }) },
  ] } };
  const path = await draft(root, [event(1, 'result', {
    surface: 'mcp', layer: 'agent', connector: 'calendar', op: 'tools/call:get_credentials',
  }, output)]);
  await approve(root, path);
  const out = join(root, 'packed');
  const result = await cli('moment', ['pack', '--out', out, '--home', join(root, 'home'), path], 'yes\n');
  assert.equal(result.status, 0, result.stderr);
  const packed = await readMomentBundle(out);
  assert.equal(Buffer.from(packed.files.get('data/run.jsonl')).includes(sentinel), false,
    'the archived MCP text still contains the nested api_key value');
});

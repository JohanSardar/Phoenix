import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, matchFrozen, replayCtx, toCall } from '../packages/answer/src/index.ts';

test('S1: a frozen-prefix read cannot move ahead of the recorded write', async () => {
  const messages = [
    ['call', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { content: 'new' } } }],
    ['result', { jsonrpc: '2.0', id: 1, result: { content: [] } }],
    ['call', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: {} } }],
    ['result', { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'new' }] } }],
  ];
  const events = messages.map(([kind, message], seq) => ({
    v: 1, capture: 'c', stream: 'mcp.fs', seq, id: `mcp.fs:${seq}`, kind,
    surface: 'mcp', connector: 'fs', ts: { wall: '2026-11-15T00:00:00Z' },
    body: { inline: JSON.stringify(message) + '\n' },
  }));
  const policy = () => ({ read_only: [{ op: 'tools/call:read_file', source: 'annotation' }] });
  const index = await buildIndex(events, {
    body: async event => Buffer.from(event.body.inline), policy, start: 'echo',
  });
  const result = matchFrozen(toCall({
    surface: 'mcp', connector: 'fs', op: 'tools/call:read_file', args: {},
    raw: { body: Buffer.from(events[2].body.inline) },
  }, policy()), replayCtx(index, policy));
  assert.equal(result.trigger, 'prefix-drift',
    'the recorded read observed a write the candidate has not performed');
});

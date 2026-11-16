import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame, HTTP_STREAM } from '../packages/taps/src/index.ts';

test('S1: echo rejects a changed cache_control tool argument', async t => {
  const root = await mkdtemp(join(tmpdir(), 'joh35-S1-'));
  const recorded = {
    model: 'review',
    tools: [{ name: 'put_object', input_schema: { type: 'object', properties: {
      key: { type: 'string' }, cache_control: { type: 'string' },
    }, required: ['key'] } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Upload the page without caching.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'put-1', name: 'put_object',
        input: { key: 'index.html', cache_control: 'no-store' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'put-1', content: 'Uploaded.' }] },
    ],
  };
  const candidate = structuredClone(recorded);
  candidate.messages[1].content[0].input.cache_control = 'public, max-age=86400';
  const request = { method: 'POST', url: '/v1/messages', httpVersion: '1.1', headers: ['content-type', 'application/json'] };
  const events = [
    ['meta', request], ['call', recorded],
    ['meta', { status: 200, headers: ['content-type', 'application/json'] }],
    ['result', { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
  ].map(([kind, value], seq) => ({
    v: 1, capture: 'recorded', stream: 'model.0', seq, id: `model.0:${seq}`, kind,
    surface: 'http', connector: 'model', ts: { wall: '2026-11-15T00:00:00Z' },
    body: { inline: JSON.stringify(value) },
  }));
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    start: 'echo', routes: {}, hmacKey: Buffer.alloc(32, 1),
    model: { connector: 'model', dialect: 'messages', provider: { url: 'http://127.0.0.1:1', headers: {} } },
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample',
      harness: { name: 'review', tree: 'review' }, recipe: { name: 'claude-code', version: '1' },
      routes: ['replay'], started_at: '2026-11-15T00:00:00Z', boot_id: 'review' } },
  });
  const link = engine.backend.open({ surface: 'http', connector: 'model', meta: { transport: 'http', request } });
  t.after(async () => { link.abort('cleanup'); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const stopped = engine.stopped.then(stop => ({ kind: stop.kind, trigger: stop.divergence?.trigger, field: stop.divergence?.field }));
  await link.write(frame('out', HTTP_STREAM.requestBody, Buffer.from(JSON.stringify(candidate)), true));
  const outcome = await Promise.race([
    link.frames()[Symbol.asyncIterator]().next().then(({ value }) => ({ kind: 'response', status: JSON.parse(Buffer.from(value.bytes)).status })).catch(() => stopped),
    stopped,
  ]);
  console.log({ outcome, prefix_edits: engine.prefixEdits() });
  assert.deepEqual(outcome, { kind: 'diverged', trigger: 'prefix-drift', field: 'history/1/content/0/input/cache_control' });
});

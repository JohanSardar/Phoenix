import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame, HTTP_STREAM } from '../packages/taps/src/index.ts';

test('S2: an extra model call after the echo prefix must not run live', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 'echo-'));
  let providerRequests = 0;
  const provider = createServer((req, res) => {
    providerRequests++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[]}');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const events = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 1, result: { tools: [] } },
  ].map((message, seq) => ({
    v: 1, capture: 'c', stream: 'mcp.fs', seq, id: `mcp.fs:${seq}`,
    kind: seq ? 'result' : 'call', surface: 'mcp', connector: 'fs',
    ts: { wall: '2026-11-15T00:00:00Z' }, body: { inline: JSON.stringify(message) + '\n' },
  }));
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    start: 'echo', routes: {}, hmacKey: Buffer.alloc(32, 1),
    model: { connector: 'model', dialect: 'chat-completions',
      provider: { url: `http://127.0.0.1:${provider.address().port}`, headers: {} } },
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample',
      harness: { name: 'review', tree: 'none' }, recipe: { name: 'review', version: '1' },
      routes: ['replay'], started_at: '2026-11-15T00:00:00Z', boot_id: 'review' } },
  });
  const links = [];
  t.after(async () => {
    for (const link of links) link.abort('test cleanup');
    await engine.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const mcp = engine.backend.open({ surface: 'mcp', connector: 'fs', meta: { transport: 'stdio' } });
  links.push(mcp);
  await mcp.write(frame('out', 0, Buffer.from(events[0].body.inline), true));
  await mcp.frames()[Symbol.asyncIterator]().next();
  const http = engine.backend.open({ surface: 'http', connector: 'model', meta: {
    transport: 'http', request: { method: 'POST', url: '/v1/chat/completions',
      headers: ['content-type', 'application/json'], httpVersion: '1.1' },
  } });
  links.push(http);
  await http.write(frame('out', HTTP_STREAM.requestBody,
    Buffer.from(JSON.stringify({ model: 'review', messages: [{ role: 'user', content: 'extra' }] })), true));
  const outcome = await Promise.race([
    http.frames()[Symbol.asyncIterator]().next().then(({ value }) => ({
      kind: 'model-response', status: JSON.parse(Buffer.from(value.bytes).toString()).status,
    })),
    engine.stopped.then(stop => ({ kind: stop.kind, trigger: stop.divergence?.trigger })),
  ]);
  assert.deepEqual({ ...outcome, providerRequests },
    { kind: 'diverged', trigger: 'prefix-drift', providerRequests: 0 });
});

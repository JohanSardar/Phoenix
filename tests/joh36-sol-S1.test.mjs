import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGzip, constants } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapture, readCapture, BlobStore } from '../packages/store/src/index.ts';
import { collect } from '../packages/capture/src/collector.ts';
import { tee, httpBackend } from '../packages/capture/src/index.ts';
import { httpGatewayTap } from '../packages/taps/src/index.ts';
import { buildIndex } from '../packages/answer/src/index.ts';

test('S1: a gzip SSE stream cancelled after response.completed remains replayable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'j36-'));
  const capture = join(root, 'capture');
  await createCapture(capture, {
    capture: 'gzip-cancellation', harness: { name: 'fetch-client', tree: 'review' },
    recipe: { name: 'generic', version: '1' }, routes: ['tap'],
    started_at: new Date().toISOString(), boot_id: 'review',
  });
  const socket = join(root, 'collector.sock');
  const collector = await collect(capture, socket, join(root, 'home'));
  let disconnected;
  const upstreamClosed = new Promise(resolve => { disconnected = resolve; });
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    const gzip = createGzip();
    gzip.pipe(res);
    res.once('close', () => { gzip.destroy(); disconnected(); });
    gzip.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    gzip.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_review","status":"completed","output":[]}}\n\n');
    gzip.flush(constants.Z_SYNC_FLUSH);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const gateway = httpGatewayTap({
    backend: tee(httpBackend(() => new URL(`http://127.0.0.1:${provider.address().port}/v1/responses`)), { socket }),
    route: () => ({ surface: 'http', connector: 'model' }),
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  let collectorClosed = false;
  t.after(async () => {
    gateway.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    if (!collectorClosed) await collector.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'review', input: 'hello', stream: true }),
  });
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('"status":"completed"') || !received.endsWith('\n\n')) {
    const next = await reader.read();
    assert.equal(next.done, false);
    received += Buffer.from(next.value).toString();
  }
  await reader.cancel();
  await upstreamClosed;
  await collector.close();
  collectorClosed = true;
  const view = await readCapture(capture);
  const result = view.allEvents.find(event => event.kind === 'result' && event.op === 'frame:back:2');
  assert.equal(result?.partial, true);
  assert.equal(result?.transport_partial, true);
  const blobs = new BlobStore(capture);
  const index = await buildIndex(view.allEvents, {
    body: async event => !event.body ? new Uint8Array() : 'inline' in event.body ? Buffer.from(event.body.inline) : blobs.get(event.body.blob),
    policy: () => ({}), start: 'echo', model: { connector: 'model', dialect: 'responses' },
  });
  console.log(JSON.stringify({ clientSawTerminal: received.includes('response.completed'), transportPartial: result.transport_partial, replayExchanges: index.exchanges.length }));
  assert.equal(index.exchanges.length, 1, 'the client received the terminal event before cancelling the gzip response');
});

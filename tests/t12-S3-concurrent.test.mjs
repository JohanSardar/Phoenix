import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { readCapture, BlobStore } from '../packages/store/src/index.ts';
import { frame, HTTP_STREAM } from '../packages/taps/src/index.ts';

test('S3: interrupted concurrent recovery must retain a live answer while a CLI prefix is awaiting stdin', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 't12-S3-concurrent-'));
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `answer-${++providerCalls}` } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const engines = [], links = [];
  t.after(async () => {
    for (const link of links) link.abort('cleanup');
    for (const engine of engines) await engine.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const invocation = { argv: ['cat'], cwd: '/work', env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
  const events = ['command-a', 'command-b'].flatMap((connector, index) => [
    ['call', 'cat', invocation],
    ['call', 'frame:out:0', 'payload\n'],
    ['result', 'frame:back:3', { type: 'exit', code: 0, signal: null }],
  ].map(([kind, op, body], seq) => ({
    v: 1, capture: 'original', stream: connector, seq, id: `${connector}:${seq}`, kind, op,
    surface: 'cli', connector, layer: seq === 1 ? 'under' : 'agent',
    ts: { wall: '2026-11-15T12:00:00Z', mono: String(index * 3 + seq + 1) },
    body: { inline: typeof body === 'string' ? body : JSON.stringify(body) },
  })));
  const evidence = { events, body: async event => Buffer.from(event.body.inline) };
  const capture = async name => {
    const path = join(root, name), view = await readCapture(path), blobs = new BlobStore(path);
    return { events: view.allEvents, body: event => event.body && 'blob' in event.body ? blobs.get(event.body.blob) : Promise.resolve(Buffer.from(event.body?.inline ?? '')) };
  };
  const start = async (name, resume) => {
    const engine = await startEngine({ evidence, resume, start: 'beginning', routes: {}, hmacKey: Buffer.alloc(32, 1),
      model: { connector: 'model', dialect: 'chat-completions', provider: { url: `http://127.0.0.1:${provider.address().port}`, headers: {} } },
      sample: { root: join(root, name), metadata: { capture: name, harness: { name: 'review', tree: 'fixture' }, recipe: { name: 'review', version: '1' }, routes: ['replay'], started_at: '2026-11-15T12:00:00Z', boot_id: name } },
    });
    engines.push(engine);
    return engine;
  };
  const cli = (engine, connector) => {
    const link = engine.backend.open({ surface: 'cli', connector, meta: invocation });
    links.push(link);
    return link;
  };
  const finishCli = async link => {
    await link.write(frame('out', 0, Buffer.from('payload\n'), true));
    for await (const response of link.frames()) if (response.stream === 3) break;
  };
  const model = async (engine, step) => {
    const link = engine.backend.open({ surface: 'http', connector: 'model', meta: { transport: 'http', request: {
      method: 'POST', url: '/v1/chat/completions', httpVersion: '1.1', headers: ['content-type', 'application/json'],
    } } });
    links.push(link);
    await link.write(frame('out', HTTP_STREAM.requestBody, Buffer.from(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: step }] })), true));
    for await (const response of link.frames()) if (response.stream === HTTP_STREAM.responseBody && response.last) return JSON.parse(Buffer.from(response.bytes)).choices[0].message.content;
  };
  const first = await start('first');
  await finishCli(cli(first, 'command-a'));
  await finishCli(cli(first, 'command-b'));
  await first.close();
  const firstTrace = await capture('first');
  const second = await start('second', [firstTrace]);
  const pendingCli = cli(second, 'command-a');
  await pendingCli.write(frame('out', 0, Buffer.alloc(0), false));
  await finishCli(cli(second, 'command-b'));
  if (second.phase() === 'prefix') await finishCli(pendingCli);
  const durable = await model(second, 'after recovery');
  pendingCli.abort('infrastructure interruption');
  await second.close();
  const secondTrace = await capture('second');
  const third = await start('third', [firstTrace, secondTrace]);
  await finishCli(cli(third, 'command-a'));
  await finishCli(cli(third, 'command-b'));
  const recovered = await model(third, 'after recovery');
  assert.equal(recovered, durable, 'The latest durable live answer must not be discarded by choosing an older equally long exchange index');
});

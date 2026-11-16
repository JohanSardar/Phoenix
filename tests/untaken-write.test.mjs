import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startToolStandIn } from '../packages/engine/src/index.ts';
import { SimulatorStore } from '../packages/answer/src/index.ts';

const time = '2026-11-16T12:00:00.000Z';
const result = text => ({ content: [{ type: 'text', text }] });

test('S4: an unsupported copy write with a synthesized no-op preserves recorded repeats', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh58-S4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'serve.mjs');
  await writeFile(script, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      let reply = { status: 'answer', value: null };
      if (request.method === 'call') {
        if (request.params.op === 'tools/call:unsupported_write') {
          reply = { status: 'unsupported', reason: 'The copy cannot perform this write' };
        } else {
          const rpc = JSON.parse(Buffer.from(request.params.raw.body, 'base64'));
          reply.value = { body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
            result: { content: [{ type: 'text', text: 'copy observation' }] } })).toString('base64') };
        }
      }
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, ...reply }));
    }
  `);
  const sandbox = { async start(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { env: { PATH: process.env.PATH }, stdio: 'pipe' });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    return { process: { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      exited, interrupted: new Promise(() => {}),
      async stop() { child.stdin.end(); await exited; } } };
  } };
  const standIn = await startToolStandIn({
    host: 'phoenix-tools', cutTime: time,
    answers: [{ id: 'session-read', connector: 'service', op: 'get', args: {},
      result: result('session observation'), observedAt: time, beforeCut: true }],
    policy: () => ({ read_only: [{ op: 'tools/call:get', source: 'annotation' }], allow_synthesized: true }),
    emulators: [{ plugin: { directory: root, descriptor: {
      phoenix_plugin: 1, connector: 'service', recognize: {}, tier: 'stateful',
      operations: ['tools/call:get', 'tools/call:unsupported_write'],
      serve: { command: [process.execPath, script], protocol: 'stdio', level: 'tool' },
    } }, options: { context: {}, replay: { sandbox,
      spec: { image: 'not-used', mounts: [], clockFile: join(root, 'clock') } } } }],
    simulator: { moment: 'S4', improverModel: 'improver', store: new SimulatorStore(join(root, 'simulator')),
      provider: { configuration: { model: 'simulator' },
        async complete() { return { text: JSON.stringify(result('no-op acknowledgement')) }; } } },
    sample: { root: join(root, 'trace'), metadata: { capture: 'S4',
      harness: { name: 'review', tree: 'none' }, recipe: { name: 'review', version: '1' },
      routes: ['tap'], started_at: time, boot_id: 'review' } },
    hmacKey: Buffer.alloc(32, 1),
  });
  t.after(() => standIn.close());
  const server = createServer(stream => standIn.accept({ destination: { host: 'phoenix-tools', port: 80 }, stream }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const ask = async name => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/service`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
    });
    return response.json();
  };
  assert.deepEqual((await ask('get')).result, result('session observation'));
  assert.deepEqual((await ask('unsupported_write')).result, result('no-op acknowledgement'));
  assert.deepEqual((await ask('get')).result, result('session observation'),
    'The copy did not take the unsupported write, so the exact session repeat must still use the recording');
});

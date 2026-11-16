import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from '../packages/runner/node_modules/yaml/dist/index.js';
import { startToolStandIn } from '../packages/engine/src/index.ts';

test('S2: a made-up world answers a read even when the starting messages contain an older observation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh42-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const made = join(root, 'made');
  await mkdir(made);
  await writeFile(join(made, 'moment.yaml'), JSON.stringify({
    phoenix_made_up: 1, time: '2026-11-16T00:00:00.000Z',
    llm: { provider: 'openai-codex', id: 'fixture' },
    tools: [{ name: 'read', service: 'pi', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [
      { role: 'user', text: 'Read status.txt.' },
      { role: 'assistant', calls: [{ tool: 'read', args: { path: 'status.txt' }, answer: 'old observation' }] },
    ],
    prompt: 'Read status.txt again; it has changed.',
    world: [{ tool: 'pi.read', args: { path: 'status.txt' }, answer: 'current written world' }],
  }));
  await writeFile(join(made, 'check.yaml'), 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Read the current world.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--made-up', made, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--id', 'review-world', '--home', join(root, 'home'), bundle], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  const manifest = parse(await readFile(join(bundle, 'moment.yaml'), 'utf8'));
  const moment = JSON.parse(await readFile(join(bundle, 'data/session-moment.json'), 'utf8'));
  const standIn = await startToolStandIn({
    host: 'phoenix-tools', hmacKey: Buffer.alloc(32, 1),
    answers: moment.answers.map(a => ({ id: a.id, connector: a.connector, op: a.op, args: a.args, result: a.result,
      observedAt: a.observed_at, beforeCut: a.before_cut, world: a.world })),
    policy: name => manifest.connectors[name],
    sample: { root: join(root, 'trace'), metadata: { capture: 'review', harness: { name: 'pi', tree: 'fixture' },
      recipe: { name: 'pi', version: '1' }, routes: ['replay'], started_at: '2026-11-16T00:00:00.000Z', boot_id: 'review' } },
  });
  const server = createServer(stream => standIn.accept({ destination: { host: 'phoenix-tools', port: 80 }, stream }));
  t.after(async () => { await new Promise(done => server.close(done)); await standIn.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/pi`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { path: 'status.txt' } } }),
  });
  const reply = await response.json();
  assert.equal(reply.result.content[0].text, 'current written world', 'The explicit world must not be shadowed by a repeat of an old observation');
});

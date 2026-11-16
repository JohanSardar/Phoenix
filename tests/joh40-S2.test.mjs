import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from '../packages/runner/node_modules/yaml/dist/index.js';
import { startToolStandIn } from '../packages/engine/src/index.ts';

test('S2: a resumed built-in read can reuse its pre-cut recorded observation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh40-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-11-16T00:00:00.000Z';
  const args = { path: 'README.md' };
  const result = { content: [{ type: 'text', text: 'Controlled project contents.' }], isError: false };
  const session = join(root, 'fixture.jsonl');
  const message = (id, parentId, value) => ({ type: 'message', id, parentId, timestamp, message: value });
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', timestamp, cwd: '/controlled-project' },
    { type: 'model_change', id: 'selection', parentId: null, timestamp, provider: 'openai-codex', modelId: 'gpt-5.1' },
    message('system', 'selection', { role: 'system', content: '', sections: { preamble: 'Controlled test.' }, toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }),
    message('user-1', 'system', { role: 'user', content: 'Read README.md.' }),
    message('assistant-1', 'user-1', { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: args }] }),
    message('result-1', 'assistant-1', { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', ...result }),
    message('assistant-2', 'result-1', { role: 'assistant', content: [{ type: 'text', text: 'Read.' }] }),
    message('user-2', 'assistant-2', { role: 'user', content: 'Read README.md again.' }),
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Read the file again.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--at', '8', '--id', 'review-read', '--check', check, '--home', join(root, 'home'), bundle],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  const manifest = parse(await readFile(join(bundle, 'moment.yaml'), 'utf8'));
  const moment = JSON.parse(await readFile(join(bundle, manifest.resume.moment), 'utf8'));
  assert.equal(moment.answers[0].before_cut, true);
  const standIn = await startToolStandIn({
    host: 'phoenix-tools', hmacKey: Buffer.alloc(32, 1),
    answers: moment.answers.map(a => ({ ...a, beforeCut: a.before_cut, observedAt: a.observed_at })),
    policy: connector => manifest.connectors[connector],
    sample: { root: join(root, 'trace'), metadata: { capture: 'review',
      harness: { name: 'pi', tree: 'unknown' }, recipe: { name: 'pi', version: '1' },
      routes: ['tap'], started_at: timestamp, boot_id: 'review' } },
  });
  const relay = createServer(stream => standIn.accept({ destination: { host: 'phoenix-tools', port: 80 }, stream }));
  t.after(async () => { relay.close(); await standIn.close(); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const response = await fetch(`http://127.0.0.1:${relay.address().port}/pi`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: args } }),
  });
  const reply = await response.json();
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result },
    'A pre-cut read is an observation, not a write that forces a no-answer divergence');
});

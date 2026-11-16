import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from '../packages/runner/node_modules/yaml/dist/index.js';
import { startToolStandIn } from '../packages/engine/src/index.ts';

test('S4: continuing the live session after a mark must not replace the saved service answer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh42-S4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'README.md'), 'Controlled project.');
  const upstream = join(root, 'upstream.mjs');
  await writeFile(upstream, `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: 'controlled', version: '1' } }
    : { content: [{ type: 'text', text: 'saved at mark' }], isError: false };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
`);
  const config = join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { calendar: { command: process.execPath, args: [upstream] } } }));
  const timestamp = '2026-11-16T00:00:00.000Z';
  const session = join(root, 'session.jsonl');
  const message = (id, parentId, value) => ({ type: 'message', id, parentId, timestamp, message: value });
  const call = id => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'mcp__calendar__list_events', arguments: {} }] });
  const answer = (id, text) => ({ role: 'toolResult', toolCallId: id, toolName: 'mcp__calendar__list_events', content: [{ type: 'text', text }], isError: false });
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', timestamp, cwd: project },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'openai-codex', modelId: 'fixture' },
    message('system', 'model', { role: 'system', content: '', sections: {}, toolsAdded: [] }),
    message('user-1', 'system', { role: 'user', content: 'Read calendar.' }),
    message('call-1', 'user-1', call('read-1')),
    message('result-1', 'call-1', answer('read-1', 'old observation')),
    message('user-2', 'result-1', { role: 'user', content: 'Read calendar again.' }),
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const cli = (...args) => spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'), ...args], { encoding: 'utf8', timeout: 30_000 });
  const marked = cli('mark', '--session', session, '--cwd', project, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--mcp-config', config, '--plugin', resolve('plugins/google-calendar'), '--home', join(root, 'home'));
  assert.equal(marked.status, 0, marked.stderr);
  const { directory } = JSON.parse(marked.stdout);
  const saved = JSON.parse(await readFile(join(directory, 'services.json'), 'utf8'));
  assert.equal(saved[0].result.content[0].text, 'saved at mark');
  await appendFile(session, [message('call-2', 'user-2', call('read-2')),
    message('result-2', 'call-2', answer('read-2', 'observed after mark'))].map(entry => JSON.stringify(entry) + '\n').join(''));
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Read calendar at the mark.\n');
  const bundle = join(root, 'moment');
  const created = cli('moment', 'create', '--mark', directory, '--id', 'review-mark', '--check', check, '--home', join(root, 'home'), bundle);
  assert.equal(created.status, 0, created.stderr);
  const manifest = parse(await readFile(join(bundle, 'moment.yaml'), 'utf8'));
  const moment = JSON.parse(await readFile(join(bundle, 'data/session-moment.json'), 'utf8'));
  const standIn = await startToolStandIn({
    host: 'phoenix-tools', hmacKey: Buffer.alloc(32, 1),
    answers: moment.answers.map(a => ({ ...a, beforeCut: a.before_cut, observedAt: a.observed_at })),
    policy: name => manifest.connectors[name],
    sample: { root: join(root, 'trace'), metadata: { capture: 'review', harness: { name: 'pi', tree: 'fixture' },
      recipe: { name: 'pi', version: '1' }, routes: ['replay'], started_at: timestamp, boot_id: 'review' } },
  });
  const relay = createServer(stream => standIn.accept({ destination: { host: 'phoenix-tools', port: 80 }, stream }));
  t.after(async () => { await new Promise(done => relay.close(done)); await standIn.close(); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const response = await fetch(`http://127.0.0.1:${relay.address().port}/calendar`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_events', arguments: {} } }),
  });
  const reply = await response.json();
  assert.equal(reply.result.content[0].text, 'saved at mark', 'A marked world must not silently become a later live observation');
});

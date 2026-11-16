import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('S1: from-beginning replay keeps the first request tool surface', async t => {
  const root = await mkdtemp(join(homedir(), '.capy/work/phoenix-joh65-S1-'));
  const name = 'phoenix-joh65-S1-' + process.pid;
  const dockerEnv = { ...process.env };
  t.after(async () => {
    spawnSync('docker', ['rm', '-f', name], { env: dockerEnv, stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  });
  const common = { timestamp: '2026-11-16T00:00:00.000Z', sessionId: 'synthetic-review', cwd: '/synthetic-project', version: '2.1.325' };
  const tool = { name: 'Read', description: 'Read a file.', input_schema: {
    type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
  } };
  const rows = [
    { type: 'user', message: { role: 'user', content: 'Say synthetic review response.' } },
    { type: 'api-request-shape', shapeHash: 'synthetic-shape', shape: { system: [{ type: 'text', text: 'Synthetic harness.' }], tools: [tool] } },
    { type: 'api-request', shapeHash: 'synthetic-shape' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'synthetic review response' }] } },
  ];
  const session = join(root, 'session.jsonl');
  await writeFile(session, rows.map(row => JSON.stringify({ ...common, ...row })).join('\n') + '\n');
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Say synthetic review response.\n');
  const bundle = join(root, 'bundle');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/claude-code/recipe.yaml'),
    '--from-beginning', '--id', 'review-first-tools', '--check', check, '--home', join(root, 'home'), bundle],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  const moment = JSON.parse(await readFile(join(bundle, 'data/session-moment.json'), 'utf8'));
  for (const dir of ['moment', 'agent', 'out', 'worktree']) await mkdir(join(root, dir));
  await writeFile(join(root, 'moment/moment.json'), JSON.stringify(moment));
  await writeFile(join(root, 'moment/loadout.json'), JSON.stringify(moment.loadout));
  await writeFile(join(root, 'moment/cut.jsonl'), rows.slice(0, moment.cut_lines).map(row => JSON.stringify({ ...common, ...row })).join('\n') + '\n');
  await writeFile(join(root, 'agent/credentials.json'), '{}');
  await writeFile(join(root, 'driver.mjs'), `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const observed = [];
const server = createServer(async (request, response) => {
  let bytes = '';
  for await (const chunk of request) bytes += chunk;
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":10}'); return; }
  const body = JSON.parse(bytes);
  observed.push((body.tools ?? []).map(tool => tool.name));
  response.setHeader('content-type', 'text/event-stream');
  for (const [type, data] of [
    ['message_start', { message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'synthetic review response' } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', {}],
  ]) response.write('event: ' + type + '\\ndata: ' + JSON.stringify({ type, ...data }) + '\\n\\n');
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const local = 'http://127.0.0.1:' + server.address().port;
mkdirSync('/tmp/source-home', { recursive: true });
mkdirSync('/tmp/source-config', { recursive: true });
const original = spawn('claude', ['-p', 'Say synthetic review response.', '--tools', 'Read',
  '--system-prompt', 'Synthetic harness.', '--model', 'claude-sonnet-4-5',
  '--permission-mode', 'bypassPermissions'], { stdio: 'ignore', cwd: '/tmp/source-home', env: {
  ...process.env, HOME: '/tmp/source-home', CLAUDE_CONFIG_DIR: '/tmp/source-config',
  IS_SANDBOX: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  ANTHROPIC_API_KEY: 'synthetic-not-a-real-key', ANTHROPIC_BASE_URL: local,
} });
if (await new Promise(resolve => original.once('close', resolve))) throw new Error('Source CLI failed');
const child = spawn(process.execPath, ['/phoenix/recipe/resume.mjs'], { stdio: 'inherit', env: {
  ...process.env, ANTHROPIC_API_KEY: 'synthetic-not-a-real-key',
  ANTHROPIC_BASE_URL: local,
  CLAUDE_CONFIG_DIR: '/phoenix/agent/.claude', PHOENIX_TOOLS_URL: local,
} });
const code = await new Promise(resolve => child.once('close', resolve));
writeFileSync('/phoenix/out/observed-tools.json', JSON.stringify(observed));
server.closeAllConnections();
server.close();
process.exitCode = code;
`);
  const replayed = spawnSync('docker', ['run', '--rm', '--name', name, '--network', 'none',
    '-v', `${resolve('recipes/claude-code')}:/phoenix/recipe:ro`,
    ...['moment', 'agent', 'out'].flatMap(dir => ['-v', `${join(root, dir)}:/phoenix/${dir}`]),
    '-v', `${join(root, 'worktree')}:/worktree:ro`, '-v', `${join(root, 'driver.mjs')}:/review-driver.mjs:ro`,
    'phoenix-claude-code-resume:2.1.325', 'node', '/review-driver.mjs'],
  { env: dockerEnv, encoding: 'utf8', timeout: 45_000 });
  assert.equal(replayed.status, 0, replayed.stderr + replayed.stdout);
  const observed = JSON.parse(await readFile(join(root, 'out/observed-tools.json'), 'utf8'));
  assert.ok(observed.length >= 2, 'Both source and replay must reach the synthetic LLM');
  console.log(JSON.stringify({ source: observed[0], recorded: moment.loadout.tools, replayed: observed.at(-1) }));
  assert.deepEqual(observed[0].sort(), [...moment.loadout.tools].sort(), 'Fixture matches a real --tools Read session');
  assert.deepEqual(observed.at(-1).sort(), [...moment.loadout.tools].sort(),
    'A fresh replay must offer the tool surface recorded in the first request, not CLI defaults');
});

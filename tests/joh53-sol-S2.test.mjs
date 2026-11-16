import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('S2: session-only MCP stand-ins expose valid schemas for token-named parameters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh53-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-11-16T00:00:00.000Z';
  const common = { timestamp, sessionId: 'synthetic-review', cwd: '/synthetic-project', version: '2.1.325' };
  const tool = { name: 'mcp__calendar__list_events', description: 'List events.', input_schema: {
    type: 'object', properties: { page_token: { type: 'string' } },
  } };
  const session = join(root, 'session.jsonl');
  const rows = [
    { type: 'user', message: { role: 'user', content: 'List events.' } },
    { type: 'api-request-shape', shapeHash: 'synthetic-shape', shape: { system: [{ type: 'text', text: 'Synthetic harness.' }], tools: [tool] } },
    { type: 'api-request', shapeHash: 'synthetic-shape' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'list-events', name: tool.name, input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'list-events', content: 'No events.' }] } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'No events.' }] } },
    { type: 'user', message: { role: 'user', content: 'List events again.' } },
  ];
  await writeFile(session, rows.map(row => JSON.stringify({ ...common, ...row })).join('\n') + '\n');
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: List events again.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/claude-code/recipe.yaml'),
    '--at', '7', '--id', 'review-mcp-schema', '--check', check, '--home', join(root, 'home'), bundle],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  const moment = JSON.parse(await readFile(join(bundle, 'data/session-moment.json'), 'utf8'));
  const loadout = join(root, 'loadout.json');
  await writeFile(loadout, JSON.stringify(moment.loadout));
  const child = spawn(process.execPath, [resolve('recipes/claude-code/mcp.mjs'), 'calendar'], {
    env: { PHOENIX_CC_LOADOUT: loadout }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, stderr);
  const listed = JSON.parse(stdout).result.tools[0];
  console.log(JSON.stringify(listed));
  const schema = listed.inputSchema.properties.page_token;
  assert.ok(typeof schema === 'boolean' || (schema !== null && typeof schema === 'object' && !Array.isArray(schema)),
    'A JSON Schema property must be a schema object or boolean, not a redaction placeholder string');
});

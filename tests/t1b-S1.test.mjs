import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S1: namespace proxies keep identical tool names on their own servers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-t1b-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-11-16T00:00:00.000Z';
  let parentId = 'model';
  const message = (id, value) => {
    const entry = { type: 'message', id, parentId, timestamp, message: value };
    parentId = id;
    return entry;
  };
  const tools = ['alpha', 'beta'].map(server => ({
    name: `mcp__${server}`, description: `Namespace-proxy for MCP server "${server}".`,
    parameters: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] },
  }));
  const entries = [
    { type: 'session', version: 3, id: 'review', timestamp, cwd: '/controlled-project' },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'openai-codex', modelId: 'gpt-5.1' },
    message('system', { role: 'system', content: '', sections: { preamble: 'Controlled fixture.' }, toolsAdded: tools }),
    message('user', { role: 'user', content: 'Search both services.' }),
    ...['alpha', 'beta'].flatMap(server => [
      message(`call-${server}`, { role: 'assistant', content: [{ type: 'toolCall', id: `search-${server}`, name: `mcp__${server}`, arguments: { tool: 'search', args: { query: 'fixture' } } }] }),
      message(`result-${server}`, { role: 'toolResult', toolCallId: `search-${server}`, toolName: `mcp__${server}`, content: [{ type: 'text', text: `${server} result` }], details: { mode: 'call', server, tool: 'search' }, isError: false }),
    ]),
  ];
  const session = join(root, 'fixture.jsonl');
  await writeFile(session, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Search both services.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--at', '4', '--id', 'review-routing', '--check', check, '--home', join(root, 'home'), bundle],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  const moment = JSON.parse(await readFile(join(bundle, 'data/session-moment.json'), 'utf8'));
  assert.deepEqual(moment.answers.map(({ connector, op }) => ({ connector, op })), [
    { connector: 'alpha', op: 'search' },
    { connector: 'beta', op: 'search' },
  ], 'A short tool name on one namespace must not reassign another namespace\'s answers');
});

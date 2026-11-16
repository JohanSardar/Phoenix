import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S1: session-only moment creation must not bypass secret stripping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh40-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-11-16T00:00:00.000Z';
  const secret = 'controlled-review-only-credential';
  const session = join(root, 'fixture.jsonl');
  const message = (id, parentId, value) => ({ type: 'message', id, parentId, timestamp, message: value });
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', timestamp, cwd: '/controlled-project' },
    { type: 'model_change', id: 'selection', parentId: null, timestamp, provider: 'openai-codex', modelId: 'gpt-5.1' },
    message('system', 'selection', { role: 'system', content: '', sections: { preamble: 'Controlled test.' }, toolsAdded: [] }),
    message('user', 'system', { role: 'user', content: 'Read the configuration.' }),
    message('assistant', 'user', { role: 'assistant', content: [{ type: 'toolCall', id: 'read-config', name: 'read', arguments: { path: 'config.json' } }] }),
    message('result', 'assistant', { role: 'toolResult', toolCallId: 'read-config', toolName: 'read', content: [{ type: 'text', text: JSON.stringify({ apiKey: secret }) }], isError: false }),
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const original = await readFile(session);
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Read the configuration.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--at', '4', '--id', 'review-secret', '--check', check, '--home', join(root, 'home'), bundle],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(await readFile(session), original, 'The source must stay untouched');
  assert.equal((await readFile(join(bundle, 'data/run.jsonl'), 'utf8')).includes(secret), false,
    'Control: the existing transcript import strips the credential');
  const leaking = [];
  for (const file of ['data/session.jsonl', 'data/session-moment.json']) {
    if ((await readFile(join(bundle, file), 'utf8')).includes(secret)) leaking.push(file);
  }
  assert.deepEqual(leaking, [], 'Session resume data must not put stripped credentials back in the bundle');
});

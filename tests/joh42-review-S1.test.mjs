import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S1: changing a recorded answer must not bypass bundle secret stripping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh42-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-11-16T00:00:00.000Z';
  const secret = 'controlled-review-only-credential';
  const session = join(root, 'session.jsonl');
  const message = (id, parentId, value) => ({ type: 'message', id, parentId, timestamp, message: value });
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', timestamp, cwd: '/controlled-project' },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'openai-codex', modelId: 'fixture' },
    message('system', 'model', { role: 'system', content: '', sections: {}, toolsAdded: [] }),
    message('user', 'system', { role: 'user', content: 'Read config.json.' }),
    message('call', 'user', { role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'config.json' } }] }),
    message('result', 'call', { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: [{ type: 'text', text: '{}' }], isError: false }),
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const original = await readFile(session);
  const replacement = join(root, 'replacement.txt');
  await writeFile(replacement, JSON.stringify({ apiKey: secret }));
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Read config.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--at', '4', '--change-answer', `6=${replacement}`, '--id', 'review-secret', '--check', check,
    '--home', join(root, 'home'), bundle], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(await readFile(session), original);
  const leaking = [];
  for (const file of ['data/session.jsonl', 'data/session-moment.json']) {
    if ((await readFile(join(bundle, file), 'utf8')).includes(secret)) leaking.push(file);
  }
  assert.deepEqual(leaking, [], 'Replacement answers must be secret-stripped before entering the bundle');
});

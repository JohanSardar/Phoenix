import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runMomentCommand } from '../packages/cli/src/moment.ts';

test('JOH-80 S4: the moment files copy retains upstream and remote-default relationships', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh80-S4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), copied = join(root, 'copied');
  await mkdir(project);
  await mkdir(copied);
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'topic');
  await writeFile(join(project, 'note.txt'), 'tracked\n');
  git('add', 'note.txt');
  const commit = git('commit-tree', git('write-tree'), '-m', 'review fixture');
  git('update-ref', 'HEAD', commit);
  git('remote', 'add', 'origin', 'https://example.invalid/project.git');
  git('update-ref', 'refs/remotes/origin/main', commit);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('branch', '--set-upstream-to=origin/main', 'topic');
  const time = '2099-01-01T00:00:00.000Z', session = join(root, 'session.jsonl');
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', cwd: project },
    { type: 'model_change', provider: 'openai-codex', modelId: 'review' },
    { type: 'message', message: { role: 'user', content: 'Inspect the branch' } },
  ].map((entry, i) => JSON.stringify({ id: `entry-${i}`, timestamp: time, ...entry })).join('\n') + '\n');
  const check = join(root, 'check.yaml'), bundle = join(root, 'moment');
  await writeFile(check, JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: 'continuation', expect: [{ final_text: { contains: 'ok' } }] }));
  assert.equal(await runMomentCommand(['create', '--session', session, '--recipe', resolve('recipes/pi/recipe.yaml'), '--at', '3', '--id', 'review', '--check', check, '--home', join(root, 'home'), bundle]), 0);
  execFileSync('tar', ['-xf', join(bundle, 'data/project.tar'), '-C', copied]);
  const upstream = spawnSync('git', ['rev-parse', '--symbolic-full-name', '@{upstream}'], { cwd: copied, encoding: 'utf8' });
  const remoteHead = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: copied, encoding: 'utf8' });
  t.diagnostic(JSON.stringify({ upstream: { status: upstream.status, stdout: upstream.stdout, stderr: upstream.stderr }, remoteHead: { status: remoteHead.status, stdout: remoteHead.stdout, stderr: remoteHead.stderr } }));
  assert.deepEqual([upstream.status, upstream.stdout.trim(), remoteHead.status, remoteHead.stdout.trim()],
    [0, 'refs/remotes/origin/main', 0, 'refs/remotes/origin/main']);
});

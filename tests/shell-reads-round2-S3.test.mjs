import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S3: symlink containment covers dot-dot traversal and implicit cwd reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-round2-S3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'copy');
  await mkdir(copy);
  await mkdir(join(root, 'outside/sub'), { recursive: true });
  await writeFile(join(root, 'outside/secret.txt'), 'OUTSIDE_COPY\n');
  await symlink('../outside/sub', join(copy, 'link'));
  await symlink('../outside', join(copy, 'cwd-link'));
  const cases = [
    { command: 'cat link/../secret.txt', cwd: copy },
    { command: 'ls', cwd: join(copy, 'cwd-link') },
  ];
  const authorized = cases.map(({ command, cwd }) => {
    const allowed = readsOnly(command, copy, cwd, copy);
    const ran = allowed ? spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8' }) : null;
    console.log(JSON.stringify({ command, allowed, status: ran?.status, stdout: ran?.stdout }));
    return allowed;
  });
  assert.deepEqual(authorized, [false, false], 'Neither symlink route may authorize reading outside the copy');
});

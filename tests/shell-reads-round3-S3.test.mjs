import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S3: cwd normalization and logical cd must not bypass physical containment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-round3-S3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'copy');
  await mkdir(join(copy, 'nested/child'), { recursive: true });
  await mkdir(join(root, 'outside/sub'), { recursive: true });
  await writeFile(join(root, 'outside/secret.txt'), 'OUTSIDE_COPY\n');
  await writeFile(join(root, 'outside.txt'), 'ESCAPED_BY_CD\n');
  await symlink('../outside/sub', join(copy, 'external'));
  await symlink('nested/child', join(copy, 'alias'));
  const cases = [
    { command: 'ls', cwd: copy + '/external/..' },
    { command: 'cd alias && cd .. && cd .. && cat outside.txt', cwd: copy },
  ];
  const authorized = cases.map(({ command, cwd }) => {
    const allowed = readsOnly(command, copy, cwd, copy);
    const ran = allowed ? spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8' }) : null;
    console.log(JSON.stringify({ command, allowed, status: ran?.status, stdout: ran?.stdout }));
    return allowed;
  });
  assert.deepEqual(authorized, [false, false], 'Neither cwd route may read outside the copy');
});

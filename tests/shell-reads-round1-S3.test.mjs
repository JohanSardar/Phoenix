import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S3: a copied symlink must not let shell reads escape the copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-S3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE_COPY\n');
  await symlink('../outside.txt', join(project, 'note.txt'));
  const command = 'cat note.txt';
  const authorized = readsOnly(command, project);
  const ran = authorized ? spawnSync('/bin/sh', ['-c', command], { cwd: project, encoding: 'utf8' }) : null;
  console.log(JSON.stringify({ command, authorized, status: ran?.status, stdout: ran?.stdout }));
  assert.equal(ran?.stdout?.includes('OUTSIDE_COPY') ?? false, false, 'Only files inside the copy may be read');
});

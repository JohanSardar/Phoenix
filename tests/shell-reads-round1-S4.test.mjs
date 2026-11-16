import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S4: cd in a pipeline must not change the following command\'s checked cwd', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-S4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE_COPY\n');
  const command = 'cd src | cat ../outside.txt';
  const authorized = readsOnly(command, project);
  const ran = authorized ? spawnSync('/bin/sh', ['-c', command], { cwd: project, encoding: 'utf8' }) : null;
  console.log(JSON.stringify({ command, authorized, status: ran?.status, stdout: ran?.stdout }));
  assert.equal(authorized, false, 'The right side of a pipeline still runs in the original cwd');
});

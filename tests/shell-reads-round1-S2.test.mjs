import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S2: an attached short-option filename must stay inside the copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(root, 'patterns.txt'), 'OUTSIDE_PATTERN\n');
  await writeFile(join(project, 'words.txt'), 'OUTSIDE_PATTERN\nunmatched\n');
  const command = 'grep -f../patterns.txt words.txt';
  const authorized = readsOnly(command, project);
  const ran = authorized ? spawnSync('/bin/sh', ['-c', command], { cwd: project, encoding: 'utf8' }) : null;
  console.log(JSON.stringify({ command, authorized, status: ran?.status, stdout: ran?.stdout }));
  assert.equal(authorized, false, 'grep must not read a pattern file outside the files copy');
});

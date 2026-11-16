import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S3: cd - must not be interpreted as a literal directory inside the copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-round4-S3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'copy');
  await mkdir(join(copy, 'src'), { recursive: true });
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE_COPY\n');
  const command = 'cd src && cd - && cd .. && cat outside.txt';
  const authorized = readsOnly(command, copy, copy, copy);
  const ran = authorized ? spawnSync('/bin/sh', ['-c', command], { cwd: copy, encoding: 'utf8' }) : null;
  const readOutside = ran?.stdout?.includes('OUTSIDE_COPY') ?? false;
  console.log(JSON.stringify({ command, authorized, status: ran?.status, readOutside }));
  assert.equal(readOutside, false, 'cd - returns to OLDPWD, allowing the following cd .. to leave the copy');
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S1: an abbreviated output option must not authorize a write on the copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'names.txt'), 'b\na\n');
  const command = 'sort --out=sorted.txt names.txt';
  const authorized = readsOnly(command, root);
  if (authorized) {
    const ran = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  }
  const written = await readFile(join(root, 'sorted.txt'), 'utf8').catch(() => null);
  console.log(JSON.stringify({ command, authorized, written }));
  assert.equal(written, null, 'A shell read must never create sorted.txt on the files copy');
});

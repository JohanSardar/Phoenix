import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S6: shell expansion must not turn a checked argument into find -exec', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-S6-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '-exec'), '');
  await writeFile(join(root, 'note.txt'), 'note\n');
  const command = "find note.txt -ex?c sh -c 'echo UNLISTED_SHELL_EXECUTED > marker.txt' \\;";
  const authorized = readsOnly(command, root);
  if (authorized) {
    const ran = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  }
  const written = await readFile(join(root, 'marker.txt'), 'utf8').catch(() => null);
  console.log(JSON.stringify({ command, authorized, written }));
  assert.equal(written, null, 'A shell read must not execute sh or write marker.txt');
});

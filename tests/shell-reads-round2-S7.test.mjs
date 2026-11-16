import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readsOnly } from '../packages/engine/src/read-only-shell.ts';

test('S7: inherited object properties are not allowlisted shell commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-round2-S7-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'copy'), bin = join(root, 'bin');
  await mkdir(copy);
  await mkdir(bin);
  await writeFile(join(bin, 'constructor'), '#!/bin/sh\nprintf UNLISTED_COMMAND_EXECUTED > marker.txt\n', { mode: 0o755 });
  const command = 'constructor';
  const authorized = readsOnly(command, copy);
  if (authorized) {
    const ran = spawnSync('/bin/sh', ['-c', command], { cwd: copy, env: { PATH: bin + ':/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  }
  const written = await readFile(join(copy, 'marker.txt'), 'utf8').catch(() => null);
  console.log(JSON.stringify({ command, authorized, written }));
  assert.equal(written, null, 'A command absent from the allowlist must never execute on the copy');
});

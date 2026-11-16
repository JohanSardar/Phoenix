import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('S1: an unreadable unrelated file must not prevent a non-git harness from running', async t => {
  const root = await mkdtemp('/tmp/phoenix-j37-S1-');
  const cwd = join(root, 'harness'), home = join(root, 'home');
  const unreadable = join(cwd, 'unreadable.txt');
  t.after(async () => {
    await chmod(unreadable, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await cp(resolve('reference-harness'), cwd, { recursive: true });
  await writeFile(unreadable, 'unrelated fixture data\n', { mode: 0o600 });
  const run = async name => {
    const marker = join(root, `${name}.ran`);
    const args = [resolve('packages/cli/src/capture.ts'), 'capture',
      '--recipe', resolve('recipes/generic/recipe.yaml'), '--cwd', cwd,
      '--output', join(root, name), '--routes', '', '--', process.execPath,
      '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
    const result = await execute(process.execPath, args, {
      env: { PATH: process.env.PATH, HOME: root, PHOENIX_HOME: home }, timeout: 20_000,
    }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    return { ...result, ran: await readFile(marker, 'utf8').catch(() => null) };
  };
  const control = await run('readable');
  assert.equal(control.ran, 'ran', `Control capture failed: ${JSON.stringify(control)}`);
  assert.equal(control.code, 0);
  await chmod(unreadable, 0o000);
  const result = await run('unreadable');
  console.log(JSON.stringify({ readable: control, unreadable: result }));
  assert.equal(result.ran, 'ran', 'Working-directory recording failures must not stop the harness');
  assert.equal(result.code, 0);
  const snapshot = JSON.parse(await readFile(join(root, 'unreadable/workdir/default.json'), 'utf8'));
  assert.equal(snapshot.incomplete, true);
  assert.ok(snapshot.unread.includes('unreadable.txt'));
});

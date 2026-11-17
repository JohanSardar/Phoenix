import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markSession } from '../packages/capture/src/index.ts';

// A mark's command-line reads (JOH-73): the host runs only reads the plugin declares read-only, and strips secrets
// from what they printed before the mark keeps it.
async function fixture(t, plan) {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh73-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), plugin = join(root, 'plugin'), recipe = join(root, 'recipe');
  for (const dir of [bin, plugin, recipe]) await mkdir(dir);
  await writeFile(join(bin, 'fakecli'), `#!/bin/sh
echo "$@" >> "${root}/ran"
printf '{"items":[{"id":"7"}],"auth_token":"tok-SECRET-1"}\\n'
printf 'Cookie: session=COOKIE-SECRET-2\\npassword = PASSWORD-SECRET-3\\n' >&2
`);
  await chmod(join(bin, 'fakecli'), 0o755);
  await writeFile(join(plugin, 'phoenix-plugin.json'), JSON.stringify({ phoenix_plugin: 1, connector: 'fake', recognize: { commands: ['fakecli'] }, tier: 'stateful', operations: ['fakecli'], read_only: ['fakecli list'], capture: { command: ['node', 'capture.mjs'], protocol: 'stdio' } }));
  await writeFile(join(plugin, 'capture.mjs'), `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  const value = r.method === "capture" ? { calls: ${JSON.stringify(plan)}.map(argv => ({ op: "fakecli", args: { argv } })) } : null;
  console.log(JSON.stringify({ phoenix_plugin: 1, id: r.id, status: "answer", value }));
}`);
  const answers = [{ connector: 'pi', op: 'bash', args: { command: 'fakecli list' }, result: { content: [{ type: 'text', text: 'listed' }] }, observed_at: '2026-11-16T12:00:00.000Z' }];
  await writeFile(join(recipe, 'moment.mjs'), `process.stdin.resume(); process.stdin.on("end", () => console.log(${JSON.stringify(JSON.stringify({ cwd: root, answers, shell: { pi: { bash: { command: 'command' } } } }))}));`);
  await writeFile(join(recipe, 'recipe.yaml'), 'name: fake\nresume:\n  moment: [node, moment.mjs]\n');
  const session = join(root, 'session.jsonl');
  await writeFile(session, '{"type":"session"}\n');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const marked = await markSession({ home: join(root, 'home'), recipe: join(recipe, 'recipe.yaml'), session, cwd: root, plugins: [plugin],
    recognize: (line, owners) => line.startsWith('fakecli ') ? [{ connector: owners[0].connector, argv: line.split(' ') }] : undefined });
  return { root, ...marked };
}

test('a mark refuses a planned command-line read that is not declared read-only, and runs nothing', async t => {
  const { root, mark } = await fixture(t, [['fakecli', 'list'], ['fakecli', 'delete', '7']]);
  assert.match(mark.world.services['fakecli command'], /^not saved: .*not declared read-only/);
  assert.equal(existsSync(join(root, 'ran')), false, 'the host ran a command before refusing the plan');
  assert.equal(mark.commands, undefined);
});

test('a mark keeps a read-only read with its tokens, cookies and passwords stripped', async t => {
  const { root, mark, directory } = await fixture(t, [['fakecli', 'list']]);
  assert.equal(mark.world.services['fakecli command'], 'saved 1 reads');
  assert.equal((await readFile(join(root, 'ran'), 'utf8')).trim(), 'list');
  const saved = await readFile(join(directory, mark.commands), 'utf8');
  const frames = JSON.parse(JSON.parse(saved)[0].response.body);
  const printed = frames.map(f => Buffer.from(f.bytes, 'base64').toString()).join('');
  assert.match(printed, /"id":"7"/);
  for (const secret of ['tok-SECRET-1', 'COOKIE-SECRET-2', 'PASSWORD-SECRET-3']) {
    assert.equal(printed.includes(secret) || saved.includes(secret), false, `the mark kept ${secret}`);
  }
});

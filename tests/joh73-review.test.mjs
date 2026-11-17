import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function emailMark(t, date, body) {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh73-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), bin = join(root, 'bin');
  await mkdir(project);
  await mkdir(bin);
  const mail = [{ id: '42', flags: [], subject: '[phoenix-test] snapshot',
    from: { name: '', addr: 'sender@example.com' }, to: { name: '', addr: 'me@example.com' },
    date, has_attachment: false }];
  const message = 'From: sender@example.com\nTo: me@example.com\nSubject: [phoenix-test] snapshot\n\n' + body;
  await writeFile(join(bin, 'himalaya'), `#!${process.execPath}
const argv = process.argv.slice(2);
const value = argv[0] === 'folder' ? [] : argv[0] === 'envelope' ? ${JSON.stringify(mail)} : ${JSON.stringify(message)};
console.log(JSON.stringify(value));
`);
  await chmod(join(bin, 'himalaya'), 0o755);
  const start = '2026-11-16T11:00:00.000Z', at = '2026-11-16T12:00:00.000Z';
  const session = join(root, 'session.jsonl');
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', timestamp: start, cwd: project },
    { type: 'model_change', timestamp: start, provider: 'openai-codex', modelId: 'fixture' },
    { type: 'message', timestamp: start, message: { role: 'user', content: 'Inspect my mail.' } },
    { type: 'message', timestamp: at, message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'mail-list', name: 'bash', arguments: { command: 'himalaya envelope list -o json' } },
    ] } },
    { type: 'message', timestamp: at, message: { role: 'toolResult', toolCallId: 'mail-list', toolName: 'bash',
      content: [{ type: 'text', text: JSON.stringify(mail) }], isError: false } },
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const ran = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'), 'mark',
    '--session', session, '--cwd', project, '--recipe', resolve('recipes/pi/recipe.yaml'),
    '--plugin', resolve('plugins/email'), '--home', join(root, 'home')], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root },
  });
  assert.equal(ran.status, 0, ran.stderr);
  const { directory } = JSON.parse(ran.stdout);
  const mark = JSON.parse(await readFile(join(directory, 'mark.json'), 'utf8'));
  assert.match(mark.world.services['himalaya command'], /^saved /);
  return JSON.parse(await readFile(join(directory, mark.commands), 'utf8'));
}

test('S1: mark strips a JSON password embedded in a himalaya message body', async t => {
  const reads = await emailMark(t, '2026-11-16 12:00+00:00', '{"password":"mail-password-S1"}\n');
  const read = reads.find(read => read.args.argv[1] === 'message');
  assert.ok(read, 'the new message was not read');
  const frames = JSON.parse(read.response.body);
  const stdout = Buffer.concat(frames.filter(f => f.stream === 1).map(f => Buffer.from(f.bytes, 'base64'))).toString();
  assert.equal(stdout.includes('mail-password-S1'), false, `commands.json retained the password: ${stdout}`);
});

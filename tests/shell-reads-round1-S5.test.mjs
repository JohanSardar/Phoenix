import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { resumeAttempt } from '../packages/runner/src/resume.ts';

test('S5: new OpenCode read-only shell calls run on the copy too', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-shell-S5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const time = '2026-11-01T12:00:00.000Z', project = '/synthetic-project';
  const fixtures = [
    { name: 'opencode', op: 'bash', args: { command: 'cat note.txt', description: 'Read the note' }, at: '2', rows: [
      { opencode_session: 1, info: { id: 'review', directory: project } },
      { info: { role: 'user', time: { created: Date.parse(time) }, model: { providerID: 'opencode-go', modelID: 'review' } }, parts: [{ type: 'text', text: 'Read the note' }] },
    ] },
  ];
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    const session = fixture.rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    const extracted = spawnSync(process.execPath, [resolve(`recipes/${fixture.name}/moment.mjs`), '--at', fixture.at], { input: session, encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    const moment = JSON.parse(extracted.stdout);
    const directory = join(root, fixture.name), recipeDirectory = join(directory, 'inputs/recipe');
    const archiveSource = join(directory, 'archive');
    await mkdir(recipeDirectory, { recursive: true });
    await mkdir(archiveSource);
    await writeFile(join(archiveSource, 'note.txt'), 'FROM_COPY\n');
    await writeFile(join(recipeDirectory, 'recipe.json'), '{}');
    const tar = spawnSync('tar', ['-cf', '-', '-C', archiveSource, 'note.txt']);
    assert.equal(tar.status, 0, tar.stderr.toString());
    const bundle = {
      manifest: { clock: { time }, resume: { moment: 'moment', session: 'session', project: { root: project, source: 'today', taken_at: time, tar: 'tar' } } },
      files: new Map([['moment', Buffer.from(extracted.stdout)], ['session', Buffer.from(session)], ['tar', tar.stdout]]),
    };
    let reply;
    const sandbox = { async start() {
      const channel = new Readable({ objectMode: true, read() {} });
      const sockets = new Set();
      const server = createServer(stream => {
        sockets.add(stream);
        stream.once('close', () => sockets.delete(stream));
        channel.push({ destination: { host: 'phoenix-tools', port: 80 }, stream });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const exited = (async () => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/${fixture.name}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: fixture.op, arguments: fixture.args } }),
        });
        reply = await response.json();
        return { code: 0 };
      })();
      return { channel, process: {
        id: 'node-only-review', stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exited, interrupted: new Promise(() => {}), clock: { clock: 'virtual', binaries: [] },
        async stop() { await exited; for (const socket of sockets) socket.destroy(); server.close(); channel.push(null); },
      } };
    } };
    const outcome = await resumeAttempt({
      id: 'review', directory, root: join(directory, 'sample'), bundle, sandbox, capture: 'review', hmacKey: Buffer.alloc(32, 1), started: async () => {},
      plan: { candidate_tree: 'review', runner: { harness: { name: fixture.name }, plugins: [], recipe: { name: fixture.name, file: 'recipe.json', resume: { login: [process.execPath, '-e', ''], command: [process.execPath], llm_hosts: { [moment.model.provider]: ['llm.invalid'] } } } } },
    });
    console.log(JSON.stringify({ harness: fixture.name, outcome, reply }));
    assert.equal(reply?.run_in_box, true, `${fixture.name} must run a new cat command on the files copy, not diverge`);
  });
});

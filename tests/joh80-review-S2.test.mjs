import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { resumeAttempt } from '../packages/runner/src/resume.ts';

test('JOH-80 S2: a literal bash body calling curl must not run on the files copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh80-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run'), recipe = join(directory, 'inputs/recipe');
  await mkdir(recipe, { recursive: true });
  await writeFile(join(recipe, 'recipe.json'), '{}');
  const channel = new PassThrough({ objectMode: true }), sockets = new Set();
  const server = createServer(stream => {
    sockets.add(stream);
    stream.once('close', () => sockets.delete(stream));
    channel.write({ destination: { host: 'phoenix-tools', port: 80 }, stream });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); channel.end(); });
  let finish, reply;
  const exited = new Promise(resolve => finish = resolve);
  const sandbox = { async start() {
    return { channel, process: {
      id: 'routing-only', stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exited, interrupted: new Promise(() => {}), clock: { clock: 'real', binaries: [] }, async stop() {},
    } };
  } };
  const time = '2026-11-17T12:00:00.000Z';
  const command = "bash -c 'curl https://example.invalid/data'";
  const outcome = await resumeAttempt({
    id: 'review', capture: 'review', directory, root: join(root, 'sample'), sandbox, hmacKey: Buffer.alloc(32, 1),
    plan: { candidate_tree: 'none', harness_image: 'unused', runner: {
      harness: { name: 'review' }, plugins: [], recipe: { name: 'review', file: 'recipe.json', resume: {
        login: [process.execPath, '-e', ''], command: ['routing-only'], llm_hosts: { review: ['llm.invalid'] },
      } },
    } },
    bundle: {
      manifest: { resume: { moment: 'moment', session: 'session', project: {
        root: '/project', tar: 'tar', source: 'git', taken_at: time,
      } }, clock: { time } },
      files: new Map([
        ['moment', Buffer.from(JSON.stringify({ cut_lines: 0, prompt: 'review', model: { provider: 'review', id: 'review' },
          loadout: {}, cwd: '/project', shell: { 'claude-code': { Bash: { command: 'command' } } }, answers: [] }))],
        ['session', Buffer.from('')], ['tar', Buffer.alloc(1024)],
      ]),
    },
    async started() {
      void fetch(`http://127.0.0.1:${server.address().port}/claude-code`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Bash', arguments: { command } } }),
      }).then(response => response.json()).then(value => reply = value).finally(() => finish({ code: 0 }));
    },
  });
  t.diagnostic(JSON.stringify({ command, outcome, reply }));
  assert.notEqual(reply?.run_in_box, true, 'The runner must not authorize this network line for real execution');
});

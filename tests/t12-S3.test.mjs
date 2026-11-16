import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner, treeDigest } from '../packages/runner/src/index.ts';
import { ContainerSandbox } from '../packages/sandbox/src/index.ts';
import { writeMomentBundle, readCapture } from '../packages/store/src/index.ts';
import { approveCheck, reviewDraft } from '../packages/approvals/src/index.ts';

test('S3: a second infrastructure interruption cannot discard an earlier durable model answer', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 't12-S3-'));
  const tree = join(root, 'harness'), home = join(root, 'home'), moment = join(root, 'moment');
  await mkdir(tree);
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {}
    const call = ++providerCalls;
    if (call === 3) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `durable-answer-${call}` } }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(async () => { await new Promise(resolve => provider.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(tree, 'main.mjs'), `
    for (let step = 1; step <= 3; step++) {
      const response = await fetch(process.env.MODEL_URL + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'step-' + step }] }),
      });
      await response.json();
    }
  `);
  await writeMomentBundle(moment, {
    manifest: { phoenix_moment: 1, id: 'repeated-outage', source: 'scenario', clock: { time: '2026-11-15T12:00:00Z', timezone: 'UTC' } },
    files: new Map([['check.draft.yaml', JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: 'run', expect: [{ max_calls: { tool: '*', count: 10 } }] })]]),
  });
  await approveCheck(moment, { home, who: 'review-fixture', reviewed: (await reviewDraft(moment)).digest });
  const image = execFileSync('docker', ['--context', 'colima', 'image', 'inspect', 'phoenix-sandbox:proof', '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
  const container = new ContainerSandbox({ cli: ['docker', '--context', 'colima'] });
  let starts = 0;
  const sandbox = { async start(spec) {
    const running = await container.start(spec);
    if (++starts === 2) {
      const iterator = running.channel[Symbol.asyncIterator].bind(running.channel);
      let connections = 0;
      running.channel[Symbol.asyncIterator] = () => {
        const inner = iterator();
        return { async next() {
          const next = await inner.next();
          if (!next.done && ++connections === 2) {
            const outage = new Error('second infrastructure interruption during recovery');
            running.channel.close(outage);
            throw outage;
          }
          return next;
        } };
      };
    }
    return running;
  } };
  const runner = new Runner({ root: home, ledger: join(home, 'approvals.jsonl'), sandbox });
  const digest = await treeDigest(tree);
  const id = await runner.plan({ moment, base: { directory: tree, digest }, candidate: { directory: tree, digest }, image,
    harness: { phoenix_harness: 1, name: 'three-model-turns', run: { command: ['node', 'main.mjs'] }, endpoints: { model: { env: 'MODEL_URL', dialect: 'chat-completions' } }, editable: ['main.mjs'] },
    model: { id: 'fixture', connector: 'model', url: `http://127.0.0.1:${provider.address().port}` }, start: 'beginning',
  });
  assert.equal((await runner.resume(id)).verdict, 'incomplete');
  assert.equal((await runner.resume(id)).verdict, 'incomplete');
  await runner.resume(id);
  const attemptRoot = join(runner.directory(id), 'samples', '0');
  const answers = async attempt => (await readCapture(join(attemptRoot, String(attempt), 'trace'))).allEvents
    .filter(event => event.kind === 'result' && event.connector === 'model')
    .map(event => JSON.parse(event.body.inline).choices[0].message.content);
  const original = await answers(0), final = await answers(2);
  assert.equal(original.length, 2);
  assert.deepEqual(final.slice(0, 2), original, 'Both answers already delivered in attempt 0 must remain imposed after an interrupted recovery');
});

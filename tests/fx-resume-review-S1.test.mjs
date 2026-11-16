import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from '../packages/runner/node_modules/yaml/dist/index.js';
import { startToolStandIn } from '../packages/engine/src/index.ts';

function nativeLine(row) {
  const prefix = JSON.stringify(row).slice(0, -1);
  let crc = 0xffffffff;
  for (const byte of Buffer.from(prefix)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return prefix + ',"crc":"' + ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0') + '"}\n';
}

test('S1: a missing full tool-result blob must not become a successful preview-only answer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-fx-review-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preview = 'preview\n'.repeat(512);
  const output = preview + 'The requested answer appears after the 4096-byte preview.\n';
  const hash = createHash('sha256').update(output).digest('hex');
  const timestamp = 1794787200000;
  const args = { path: 'report.txt' };
  const records = [
    { kind: 'session_created', id: 'review-session', workspace: '/controlled-project', role: 'root', host: 'acp' },
    { kind: 'set', key: 'prefs', value: { provider: 'codex', model: 'gpt-6-luna', effort: 'medium', fast_mode: false } },
    { kind: 'turn_started', turn: 1 },
    { kind: 'item', turn: 1, type: 'user', data: { text: 'Read report.txt.', images: [] } },
    { kind: 'item', turn: 1, type: 'tool_call', data: { call_id: 'read-1', tool_name: 'read_file', arguments_json: JSON.stringify(args) } },
    { kind: 'item', turn: 1, type: 'tool_result', data: { call_id: 'read-1', tool_name: 'read_file', status: 'success', artifact_ref: `result-${hash}.txt`, stored_bytes: Buffer.byteLength(output), completeness: 'complete', preview } },
    { kind: 'item', turn: 1, type: 'assistant', data: { text: 'Read.' } },
    { kind: 'turn_committed', turn: 1 },
    { kind: 'closed' },
  ];
  const session = join(root, 'log.jsonl');
  await writeFile(session, records.map((row, index) => nativeLine({ v: 1, seq: index + 1, ts: timestamp + index, ...row })).join(''));
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 2, tiebreak: 1 }\nscope: continuation\nintent: Read the complete report.\n');
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--session', session, '--recipe', resolve('recipes/fx/recipe.yaml'),
    '--at', '4', '--id', 'review-output', '--check', check, '--home', join(root, 'home'), bundle],
  { encoding: 'utf8', timeout: 30_000 });
  if (created.status !== 0) {
    assert.match(created.stderr, /blob|result|scan|complete|answer/i);
    return;
  }
  const manifest = parse(await readFile(join(bundle, 'moment.yaml'), 'utf8'));
  const moment = JSON.parse(await readFile(join(bundle, manifest.resume.moment), 'utf8'));
  const standIn = await startToolStandIn({
    host: 'phoenix-tools', hmacKey: Buffer.alloc(32, 1),
    answers: moment.answers.map(a => ({ ...a, beforeCut: a.before_cut, observedAt: a.observed_at })),
    policy: connector => ({ ...manifest.connectors?.[connector] }),
    sample: { root: join(root, 'trace'), metadata: { capture: 'review',
      harness: { name: 'fx', tree: 'unknown' }, recipe: { name: 'fx', version: '1' },
      routes: ['tap'], started_at: new Date(timestamp).toISOString(), boot_id: 'review' } },
  });
  const relay = createServer(stream => standIn.accept({ destination: { host: 'phoenix-tools', port: 80 }, stream }));
  t.after(async () => { relay.close(); await standIn.close(); });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const reply = await fetch(`http://127.0.0.1:${relay.address().port}/fx`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: args } }),
  }).then(response => response.json(), () => undefined);
  if (!reply) return assert.equal((await standIn.stopped).trigger, 'no-answer');
  assert.ok(reply.error || reply.result?.content?.[0]?.text === output,
    `A missing full result must stop the replay; received ${reply.result?.content?.[0]?.text?.length} bytes, isError=${reply.result?.isError}, expected ${output.length} bytes or divergence`);
});

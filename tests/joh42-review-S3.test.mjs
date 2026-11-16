import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S3: existing capture-based moment creation still accepts an event mark', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh42-S3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { v: 1, capture: 'review', stream: 'session', ts: { wall: '2026-11-16T00:00:00.000Z' }, verbatim: ['body.inline'] };
  const events = [
    { ...base, seq: 0, kind: 'meta', op: 'transcript.coverage', body: { inline: JSON.stringify({ harness_versions: ['1'], carries: ['text'], lacks: ['wire'] }) } },
    { ...base, seq: 1, kind: 'meta', op: 'assistant', id: 'answer', body: { inline: 'The meeting is at 4pm.' } },
    { ...base, seq: 2, kind: 'correction', id: 'correction', at: 'answer', body: { inline: 'The meeting is at 3pm.' } },
  ];
  const recorded = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'record', '--home', join(root, 'home')], { input: events.map(e => JSON.stringify(e) + '\n').join(''), encoding: 'utf8' });
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
  const { capture } = JSON.parse(recorded.stdout);
  const bundle = join(root, 'moment');
  const created = spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'),
    'moment', 'create', '--capture', capture, '--mark', 'answer', '--id', 'review-existing', bundle],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(created.status, 0, `The existing capture/event-mark command must stay available: ${created.stderr}`);
  assert.match(await readFile(join(bundle, 'check.draft.yaml'), 'utf8'), /The meeting is at 3pm/);
});

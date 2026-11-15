import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('S3: a recorded text-only run can become a moment without tool connectors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-setup-S3-'));
  try {
    const base = { v: 1, capture: 'source', stream: 'session',
      ts: { wall: '2026-11-15T00:00:00Z' }, verbatim: ['body.inline'] };
    const events = [
      { ...base, seq: 0, kind: 'meta', op: 'transcript.coverage', verbatim: [],
        body: { inline: JSON.stringify({ harness_versions: ['1'], carries: ['text'], lacks: ['wire'] }) } },
      { ...base, seq: 1, kind: 'meta', op: 'assistant', id: 'wrong-answer',
        body: { inline: 'The meeting is at 4pm.' } },
      { ...base, seq: 2, kind: 'correction', id: 'correction', at: 'wrong-answer',
        body: { inline: 'The meeting is at 3pm.' } },
    ];
    const recorded = spawnSync(process.execPath, [resolve('packages/cli/src/record.ts'),
      '--home', join(root, 'home')], { input: events.map(e => JSON.stringify(e) + '\n').join(''), encoding: 'utf8' });
    assert.equal(recorded.status, 0, recorded.stderr);
    const { capture } = JSON.parse(recorded.stdout);
    const out = join(root, 'moment');
    const command = spawnSync(process.execPath, [resolve('packages/cli/src/moment.ts'),
      'create', '--capture', capture, '--mark', 'wrong-answer', '--id', 'wrong-time', out], { encoding: 'utf8' });
    assert.equal(command.status, 0,
      `A text-only run has no connector to name, but moment create requires one:\n${command.stderr}`);
    assert.match(await readFile(join(out, 'check.draft.yaml'), 'utf8'), /The meeting is at 3pm/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

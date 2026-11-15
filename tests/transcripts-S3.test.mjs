import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('S3: record keeps valid prefix events when a later row is not UTF-8', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-review-utf8-'));
  try {
    const base = {
      v: 1, capture: 'source', stream: 'generated',
      ts: { wall: '2026-11-15T00:00:00Z' }, verbatim: [],
    };
    const coverage = { ...base, seq: 0, kind: 'meta', op: 'transcript.coverage',
      body: { inline: JSON.stringify({ harness_versions: ['1'], carries: ['text'], lacks: ['wire'] }) } };
    const result = { ...base, seq: 1, kind: 'result', body: { inline: 'generated harmless result' } };
    const input = Buffer.concat([
      Buffer.from(JSON.stringify(coverage) + '\n' + JSON.stringify(result) + '\n'),
      Buffer.from([0xff, 0x0a]),
    ]);
    const recorded = spawnSync(process.execPath, [resolve('packages/cli/src/record.ts'),
      '--home', join(directory, 'home'), '--reader', 'generated'], { encoding: 'utf8', input });
    assert.equal(recorded.status, 1, recorded.stderr);
    const imported = JSON.parse(recorded.stdout);
    assert.equal(imported.complete, false);
    assert.equal(imported.events, 2, 'a later invalid UTF-8 row must not erase the valid prefix');
    const events = (await readFile(join(imported.capture, imported.segment), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.kind === 'result' && event.body.inline === 'generated harmless result'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('S2: record never restores stripped URL credentials while namespacing a stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-review-stream-'));
  try {
    const credentials = 'review-user:generated-harmless-password';
    const event = {
      v: 1, capture: 'source', stream: `https://${credentials}@example.invalid/rpc`, seq: 0,
      ts: { wall: '2026-11-15T00:00:00Z' }, kind: 'meta',
      op: 'transcript.coverage', verbatim: ['stream'],
      body: { inline: JSON.stringify({ harness_versions: ['1'], carries: ['text'], lacks: ['wire'] }) },
    };
    const result = spawnSync(process.execPath, [resolve('packages/cli/src/record.ts'),
      '--home', join(directory, 'home'), '--reader', 'generated'],
    { encoding: 'utf8', input: JSON.stringify(event) + '\n' });
    assert.equal(result.status, 0, result.stderr);
    const imported = JSON.parse(result.stdout);
    assert.equal(imported.complete, true);
    const segment = await readFile(join(imported.capture, imported.segment), 'utf8');
    assert.equal(segment.includes(credentials), false,
      'secret stripping must cover stream metadata in the persisted import segment');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

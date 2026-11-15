import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCapture, createTraceWriter, readCapture, digest } from '../packages/store/src/index.ts';

test('S4: a drop range never includes an accepted and persisted event', async () => {
  const root = await mkdtemp(join(import.meta.dirname, 'queue-'));
  try {
    await createCapture(root, { capture: 'cap', harness: { name: 'h', tree: digest('h') },
      recipe: { name: 'r', version: '1' }, routes: ['tap'],
      started_at: '2026-11-15T00:00:00Z', boot_id: 'boot' });
    const writer = createTraceWriter(root, { capture: 'cap', stream: 's', maxQueuedBytes: 1024 });
    const event = (seq, size = 0) => ({ v: 1, capture: 'cap', stream: 's', seq,
      ts: { wall: '2026-11-15T00:00:00Z', mono: String(seq) }, kind: 'call',
      ...(size ? { body: { inline: 'x'.repeat(size) } } : {}) });
    assert.deepEqual([event(0), event(1, 2000), event(2), event(3, 2000)]
      .map((e) => writer.append(e)), ['queued', 'dropped', 'queued', 'dropped']);
    await writer.close();
    const view = await readCapture(root);
    assert.ok(view.allEvents.some((e) => e.stream === 's' && e.seq === 2));
    const ranges = view.allEvents.filter((e) => e.kind === 'gap').map((e) => e.dropped);
    assert.equal(ranges.some((r) => r.from <= 2 && r.to >= 2), false,
      `persisted sequence 2 is reported dropped: ${JSON.stringify(ranges)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

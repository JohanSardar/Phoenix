import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMomentBundle, readApprovalsLedger } from '../packages/store/src/index.ts';
import { acceptMoment, autoLock, ledgerPath } from '../packages/approvals/src/index.ts';

test('S2: accepting after a torn ledger append cannot silently lose the acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-approvals-S2-'));
  try {
    const home = join(root, 'home');
    const moment = join(root, 'moment');
    await writeMomentBundle(moment, {
      manifest: { phoenix_moment: 1, id: 'm', source: 'scenario', start: 'beginning', lock: 'auto' },
      files: new Map([['check.draft.yaml', JSON.stringify({ phoenix_check: 1,
        samples: { base: 1, tiebreak: 0 }, scope: 'continuation', intent: 'Move the meeting.' })]]),
    });
    const { bundle } = await autoLock(moment, { home, who: 'author' });
    const path = ledgerPath(home);
    await appendFile(path, '{"phoenix_ledger":1');
    const before = await readFile(path, 'utf8');
    assert.equal((await readApprovalsLedger(path)).issues[0]?.kind, 'torn');
    let accepted;
    try {
      accepted = await acceptMoment(moment, { home, who: 'recipient', reviewed: bundle.lockHash });
    } catch {
      assert.equal(await readFile(path, 'utf8'), before, 'refusal must preserve the ledger');
      return;
    }
    const { entries, issues } = await readApprovalsLedger(path);
    assert.ok(entries.some(e => e.how === 'accepted' && e.lock_hash === accepted.entry.lock_hash),
      `acceptMoment reported success, but its entry disappeared: ${JSON.stringify({ entries: entries.map(e => e.how), issues })}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

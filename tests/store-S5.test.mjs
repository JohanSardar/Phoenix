import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeMomentBundle, readMomentBundle, digest } from '../packages/store/src/index.ts';

test('S5: bundle validation rejects a check data path outside the bundle', async () => {
  const root = await mkdtemp(join(import.meta.dirname, 'bundle-'));
  try {
    const bundle = join(root, 'moment');
    await writeFile(join(root, 'outside.json'), '{"private":"outside-bundle"}');
    await writeMomentBundle(bundle, { manifest: { phoenix_moment: 1, id: 'm', source: 'scenario' },
      files: new Map() });
    const manifest = await readFile(join(bundle, 'moment.yaml'));
    const check = JSON.stringify({ phoenix_check: 1, samples: { base: 2, tiebreak: 1 },
      scope: 'run', expect: [{ end_state: { connector: 'c', equals: '../outside.json' } }] });
    await writeFile(join(bundle, 'check.yaml'), check);
    await writeFile(join(bundle, 'moment.lock.json'), JSON.stringify({ phoenix_lock: 1,
      moment: 'm', manifest: digest(manifest), check: digest(check), checks: {}, data: {}, fills: {},
      how: 'approved', approved_by: 'review-fixture', approved_at: '2026-11-15T00:00:00Z' }));
    await assert.rejects(readMomentBundle(bundle), /path|outside|bundle|reference/i,
      'an intact lock must not make an escaping check reference acceptable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

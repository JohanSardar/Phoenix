import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readMomentBundle } from '../packages/store/src/index.ts';
import { sandbox, cli, event, draft, approve } from './t17-helpers.mjs';

test('S1: packing strips secrets supplied after capture without changing the private revision', async t => {
  const root = await sandbox(t);
  const sentinel = 'review-sentinel-not-a-real-credential';
  const path = await draft(root, [event(1, 'mark')], { prompt: JSON.stringify({ api_key: sentinel }) });
  await approve(root, path);
  const before = await readFile(join(path, 'moment.yaml'));
  const out = join(root, 'packed');
  const result = await cli('moment', ['pack', '--out', out, '--home', join(root, 'home'), path], 'yes\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(join(path, 'moment.yaml')), before);
  const packed = await readMomentBundle(out);
  assert.equal(packed.manifest.prompt.includes(sentinel), false,
    'the shareable manifest still contains the prompt api_key value');
});

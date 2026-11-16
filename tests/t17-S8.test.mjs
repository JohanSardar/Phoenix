import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { digest, readMomentBundle } from '../packages/store/src/index.ts';
import { sandbox, cli, event, draft, approve } from './t17-helpers.mjs';

test('S8: packing does not publish original sensitive filenames in its scrub report', async t => {
  const root = await sandbox(t);
  const email = 'jane.doe@northwind-mail.com';
  const bytes = Buffer.from(JSON.stringify({ contact: email }));
  const hash = digest(bytes);
  const snapshot = {
    phoenix_workdir: 1, path: '/Users/reviewer/project', ignored_copied: false, unread: [],
    entries: [{ path: `contacts/${email}.json`, mode: '100644', state: 'committed', blob: hash }],
  };
  const path = await draft(root, [event(1, 'mark')], { workdir: 'data/workdir/run.json' }, new Map([
    ['data/workdir/run.json', JSON.stringify(snapshot)], [`data/blobs/${hash.slice(7)}`, bytes],
  ]));
  await approve(root, path);
  const out = join(root, 'packed');
  const result = await cli('moment', ['pack', '--out', out, '--home', join(root, 'home'), path], 'yes\n');
  assert.equal(result.status, 0, result.stderr);
  const packed = await readMomentBundle(out);
  const workdir = JSON.parse(Buffer.from(packed.files.get('data/workdir/run.json')).toString());
  assert.equal(workdir.entries[0].path.includes(email), false);
  assert.equal(JSON.stringify(packed.manifest.packed).includes(email), false,
    'the packed scrub report reintroduces the original email-bearing filename');
});

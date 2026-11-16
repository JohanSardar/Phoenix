import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readMomentBundle } from '../packages/store/src/index.ts';
import { sandbox, cli, event, draft, approve } from './t17-helpers.mjs';

test('S2: packing scrubs personal data in trace, manifest and workdir metadata', async t => {
  const root = await sandbox(t);
  const email = 'jane.doe@northwind-mail.com';
  const workdir = { phoenix_workdir: 1, path: `/Users/${email}/project`, entries: [], ignored_copied: false, unread: [`notes/${email}.txt`] };
  const path = await draft(root, [event(1, 'mark', { task: email }, email)], {
    run: { capture: 'review', task: email }, prompt: email, workdir: 'data/workdir/run.json',
  }, new Map([['data/workdir/run.json', JSON.stringify(workdir)]]));
  await approve(root, path);
  const out = join(root, 'packed');
  const result = await cli('moment', ['pack', '--out', out, '--home', join(root, 'home'), path], 'yes\n');
  assert.equal(result.status, 0, result.stderr);
  const packed = await readMomentBundle(out);
  const trace = JSON.parse(Buffer.from(packed.files.get('data/run.jsonl')).toString());
  assert.equal(packed.manifest.prompt.includes(email), false);
  assert.equal(trace.body.inline.includes(email), false);
  const leaked = ['moment.yaml', 'data/run.jsonl', 'data/workdir/run.json'].filter(file => Buffer.from(packed.files.get(file)).includes(email));
  assert.deepEqual(leaked, [], 'personal data survived outside the bodies that pack scans');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, finishedReplay, git } from './workbench-review-helpers.mjs';

test('S1: pull-request output must not include non-editable files from the selected base', async t => {
  const f = await fixture(t, { phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: 'run',
    expect: [{ max_calls: { tool: '*', count: 1 } }] }, async repo => {
    git(repo, 'checkout', '-qb', 'other-base');
    await writeFile(join(repo, 'readonly.txt'), 'unrelated non-editable change\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'unrelated change');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    return base;
  });
  await finishedReplay(f, ['pass']);
  const remote = join(f.root, 'origin.git');
  git(f.root, 'init', '-q', '--bare', remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  git(f.repo, 'push', '-q', 'origin', 'main');
  const bin = join(f.root, 'bin'), captured = join(f.root, 'pr-args.json');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[1] === 'list') console.log('[]');
else { writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args)); console.log('https://example.test/pull/1'); }
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  await assert.rejects(f.api.makePatch({ pullRequest: true }), /non-editable paths: readonly\.txt/,
    'A pull request whose actual diff carries non-editable files must be refused');
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/phoenix'), '', 'Nothing is pushed for a refused pull request');
  await assert.rejects(readFile(captured, 'utf8'), { code: 'ENOENT' }, 'No pull request is opened');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('C1: a marked project must not put an untracked login into the moment bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh60-mark-C1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  execFileSync('git', ['init', '-q', project]);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  await writeFile(join(project, '.git/objects/info/alternates'), resolve(common, 'objects') + '\n');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'HEAD', head], { cwd: project });
  const credential = `controlled-${randomUUID()}`;
  await writeFile(join(project, 'credentials.json'), JSON.stringify({ apiKey: credential }));
  const timestamp = '2026-11-16T12:30:00.000Z';
  const session = join(root, 'session.jsonl');
  await writeFile(session, [
    { type: 'session', version: 3, id: 'review', timestamp, cwd: project },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'openai-codex', modelId: 'fixture' },
    { type: 'message', id: 'system', parentId: 'model', timestamp,
      message: { role: 'system', content: '', sections: {}, toolsAdded: [] } },
    { type: 'message', id: 'user', parentId: 'system', timestamp,
      message: { role: 'user', content: 'Inspect the project.' } },
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const cli = (...args) => spawnSync(process.execPath, [resolve('packages/cli/src/phoenix.ts'), ...args],
    { encoding: 'utf8', timeout: 30_000 });
  const marked = cli('mark', '--session', session, '--cwd', project,
    '--recipe', resolve('recipes/pi/recipe.yaml'), '--home', join(root, 'home'));
  assert.equal(marked.status, 0, marked.stderr);
  const { directory } = JSON.parse(marked.stdout);
  const check = join(root, 'check.yaml');
  await writeFile(check, 'phoenix_check: 1\nsamples: { base: 1, tiebreak: 0 }\nscope: continuation\nintent: Inspect the project.\n');
  const bundle = join(root, 'moment');
  const created = cli('moment', 'create', '--mark', directory, '--id', 'review-mark',
    '--check', check, '--home', join(root, 'home'), bundle);
  assert.equal(created.status, 0, created.stderr);
  const { resumes } = JSON.parse(created.stdout);
  const tar = await readFile(join(bundle, resumes.project.tar));
  assert.equal(tar.includes(Buffer.from(credential)), false,
    'The mark files copy bypassed secret stripping and bundled the project login');
});

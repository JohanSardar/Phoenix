import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S2: a historical cut does not import tool pruning that happened after the cut', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-opencode-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['moment', 'agent', 'out', 'worktree', 'bin']) {
    await mkdir(join(root, directory));
  }
  const time = 1_794_787_200_000;
  const session = [
    { opencode_session: 1, info: { id: 'ses_review', directory: join(root, 'project'), time: { created: time } } },
    { info: { id: 'msg_user', role: 'user', agent: 'build', time: { created: time }, model: { providerID: 'anthropic', modelID: 'fixture-model' } },
      parts: [{ type: 'text', text: 'Read the project.' }] },
    { info: { id: 'msg_read', role: 'assistant', providerID: 'anthropic', modelID: 'fixture-model', time: { created: time + 1 } },
      parts: [{ type: 'tool', tool: 'read', callID: 'read-project', state: {
        status: 'completed', input: { filePath: '/controlled-project/README.md' },
        output: 'The project uses blue widgets.', title: 'README.md', metadata: {},
        time: { start: time + 1, end: time + 2, compacted: time + 100_000 },
      } }] },
    { info: { id: 'msg_next', role: 'assistant', providerID: 'anthropic', modelID: 'fixture-model', time: { created: time + 3 } },
      parts: [{ type: 'text', text: 'The widgets are blue.' }] },
  ].map(entry => JSON.stringify(entry));
  const made = spawnSync(process.execPath, [resolve('recipes/opencode/moment.mjs'), '--at', '4'],
    { input: session.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const moment = JSON.parse(made.stdout);
  await writeFile(join(root, 'moment/moment.json'), JSON.stringify(moment));
  await writeFile(join(root, 'moment/loadout.json'), JSON.stringify(moment.loadout));
  await writeFile(join(root, 'moment/cut.jsonl'), session.slice(0, moment.cut_lines).join('\n') + '\n');
  await writeFile(join(root, 'agent/auth.json'), '{}');
  await writeFile(join(root, 'stand-in.mjs'), '');
  await writeFile(join(root, 'bin/git'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(root, 'bin/opencode'), `#!/usr/bin/env node
const fs = require('node:fs');
const [command, file] = process.argv.slice(2);
if (command === 'import') fs.copyFileSync(file, process.env.REVIEW_IMPORT);
if (command === 'export') process.stdout.write(fs.readFileSync(process.env.REVIEW_IMPORT));
`, { mode: 0o700 });
  await writeFile(join(root, 'preload.mjs'), `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const root = process.env.REVIEW_ROOT;
const map = path => typeof path !== 'string' ? path
  : path.replace(/^\\/phoenix\\/recipe\\/stand-in\\.mjs$/, root + '/stand-in.mjs')
    .replace(/^\\/phoenix\\//, root + '/').replace(/^\\/worktree(?=\\/|$)/, root + '/worktree');
for (const name of ['copyFileSync', 'cpSync', 'openSync', 'existsSync', 'mkdirSync', 'readFileSync', 'renameSync', 'writeFileSync']) {
  const original = fs[name];
  fs[name] = (...args) => original(...args.map(map));
}
syncBuiltinESMExports();
`);
  const ran = spawnSync(process.execPath,
    [resolve('recipes/opencode/resume.mjs')], {
      env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
        NODE_OPTIONS: '--import ' + join(root, 'preload.mjs'),
        REVIEW_ROOT: root, REVIEW_IMPORT: join(root, 'imported.json') },
      encoding: 'utf8', timeout: 10_000,
    });
  assert.equal(ran.status, 0, ran.stderr);
  const imported = JSON.parse(await readFile(join(root, 'imported.json'), 'utf8'));
  const state = imported.messages[1].parts[0].state;
  assert.equal(state.output, 'The project uses blue widgets.');
  assert.equal(state.time.compacted, undefined,
    'OpenCode hides any tool output with time.compacted; this pruning was still in the future at the cut');
});

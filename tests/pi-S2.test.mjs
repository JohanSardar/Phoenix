import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCapture, readCapture } from '../packages/store/src/index.ts';

test('S2: adding a Pi transcript keeps live tap evidence in the same run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'phoenix-pi-S2-'));
  try {
    const root = join(home, 'captures', 'controlled-capture');
    const timestamp = '2026-11-15T00:00:00.000Z';
    await createCapture(root, {
      capture: 'controlled-capture', harness: { name: 'pi', tree: `sha256:${'0'.repeat(64)}` },
      recipe: { name: 'pi', version: '1' }, routes: ['cli-proxy'], started_at: timestamp, boot_id: 'fixture',
    });
    const live = { v: 1, capture: 'controlled-capture', stream: 'cli', route: 'tap',
      ts: { wall: timestamp, mono: '1' }, surface: 'cli', connector: 'ls', layer: 'agent' };
    await writeFile(join(root, 'seg', 'cli.jsonl'), [
      { ...live, seq: 0, id: 'live-ls', kind: 'call', op: 'ls', body: { inline: '{"argv":["ls"]}' } },
      { ...live, seq: 1, kind: 'close' },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    const before = await readCapture(root);
    assert.equal(before.runs()[0].task, '');
    assert.equal(before.unattributed.length, 0);
    const source = join(home, 'controlled-session.jsonl');
    await writeFile(source, [
      { type: 'session', version: 3, id: 'controlled-session', timestamp, cwd: '/controlled-project' },
      { type: 'message', id: 'fixture-user', parentId: null, timestamp,
        message: { role: 'user', content: 'Controlled fixture only', timestamp: Date.parse(timestamp) } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    const imported = spawnSync(process.execPath, [resolve('packages/cli/src/import.ts'),
      '--home', home, '--capture', 'controlled-capture', '--recipe', resolve('recipes/pi/recipe.yaml'), source],
    { encoding: 'utf8', timeout: 30_000 });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).complete, true);
    const after = await readCapture(root);
    assert.equal(after.unattributed.filter(event => event.route === 'tap').length, 0,
      'Importing the session must not strand the existing live ls and close events outside every run');
    const run = after.runs().find(run => run.task === '');
    assert.ok(run, 'The original single-launch run must still exist');
    const events = [];
    for await (const event of after.events(run)) events.push(event);
    assert.ok(events.some(event => event.id === 'live-ls'));
    assert.ok(events.some(event => event.op === 'session.message'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

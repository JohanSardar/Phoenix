import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('S1: import accepts a schema-valid recipe.yaml in the documented YAML syntax', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-review-yaml-'));
  try {
    const coverage = {
      v: 1, capture: 'source', stream: 'generated', seq: 0,
      ts: { wall: '2026-11-15T00:00:00Z' }, kind: 'meta',
      op: 'transcript.coverage', verbatim: [],
      body: { inline: JSON.stringify({ harness_versions: ['1'], carries: ['text'], lacks: ['wire'] }) },
    };
    await writeFile(join(directory, 'reader.mjs'),
      `for await (const chunk of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(coverage) + '\n')});\n`);
    await writeFile(join(directory, 'source.jsonl'), '{"generated":"harmless"}\n');
    await writeFile(join(directory, 'recipe.yaml'), [
      'phoenix_recipe: 1',
      'name: generated',
      'harness_versions: ["1"]',
      'routes:',
      '  - versions: "1"',
      '    login_mode: api-key',
      '    surfaces: { model: [transcript] }',
      'transcript_reader:',
      `  command: [${JSON.stringify(process.execPath)}, reader.mjs]`,
      '  harness_versions: ["1"]',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [resolve('packages/cli/src/import.ts'),
      '--home', join(directory, 'home'), '--recipe', join(directory, 'recipe.yaml'),
      join(directory, 'source.jsonl')], { encoding: 'utf8' });
    assert.equal(result.status, 0, `valid documented YAML recipe should import successfully: ${result.stderr}`);
    const imported = JSON.parse(result.stdout);
    assert.equal(imported.complete, true);
    assert.match(await readFile(join(imported.capture, imported.segment), 'utf8'), /transcript.coverage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

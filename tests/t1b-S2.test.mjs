import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

test('S2: a candidate extension can add a tool to the resumed pi loadout', async t => {
  const root = await realpath(await mkdtemp(join(resolve('.'), '.t1b-S2-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['candidate/extensions', 'moment', 'agent', 'out']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const timestamp = '2026-11-16T00:00:00.000Z';
  await writeFile(join(root, 'moment/cut.jsonl'), [
    { type: 'session', version: 3, id: 'fixture', timestamp, cwd: '/worktree' },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'anthropic', modelId: 'claude-haiku-4-5' },
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  await writeFile(join(root, 'moment/moment.json'), JSON.stringify({ prompt: 'Controlled offline probe.', model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }));
  await writeFile(join(root, 'moment/loadout.json'), JSON.stringify({
    sections: {}, harness_sections: ['addendum'], tools: [{ name: 'recorded_tool', description: 'Recorded tool.',
      parameters: { type: 'object', properties: {} }, connector: 'fixture', op: 'recorded_tool' }],
  }));
  await writeFile(join(root, 'agent/settings.json'), '{}\n');
  await writeFile(join(root, 'agent/auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'offline-fixture-placeholder' } }));
  await writeFile(join(root, 'clock'), '+0s\n');
  await writeFile(join(root, 'candidate/extensions/add-tool.mjs'), `
import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.registerTool({ name: 'candidate_tool', label: 'Candidate tool', description: 'Added by the candidate.',
    parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'fixture' }], details: {} }; } });
  pi.on('before_agent_start', event => {
    writeFileSync('/phoenix/out/probe.json', JSON.stringify({
      registered: pi.getAllTools().map(tool => tool.name), selected: event.systemPromptOptions.selectedTools,
    }));
    process.exit(0);
  });
}
`);
  const mounted = [
    [resolve('recipes/pi'), '/phoenix/recipe', true],
    [join(root, 'candidate'), '/worktree', true],
    [join(root, 'moment'), '/phoenix/moment', true],
    [join(root, 'agent'), '/phoenix/agent', false],
    [join(root, 'out'), '/phoenix/out', false],
    [join(root, 'clock'), '/phoenix-clock', true],
  ].flatMap(([source, target, readOnly]) => ['--mount', `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`]);
  const run = spawnSync('docker', ['run', '--rm', '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    ...mounted, '--workdir', '/worktree', '--env', 'PHOENIX_TOOLS_URL=http://phoenix-tools',
    'phoenix-pi-resume:1.5.2', 'node', '/phoenix/recipe/resume.mjs'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///Users/johansardar/.colima/default/docker.sock' },
  });
  assert.equal(run.status, 0, run.stderr);
  const probe = JSON.parse(await readFile(join(root, 'out/probe.json'), 'utf8'));
  assert.ok(probe.registered.includes('candidate_tool'), 'The extension was loaded by the real recipe');
  assert.ok(probe.selected.includes('candidate_tool'),
    `A tool registered by the candidate must be visible to the LLM; selected tools: ${JSON.stringify(probe.selected)}`);
});

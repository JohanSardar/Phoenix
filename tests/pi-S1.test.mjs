import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('S1: capture preserves the native Pi session directory and --continue', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phoenix-pi-S1-')));
  let overlay;
  try {
    const cwd = join(root, 'project'), agent = join(root, 'agent'), capture = join(root, 'capture');
    for (const dir of [cwd, agent, capture]) await mkdir(dir);
    const sessionDir = join(agent, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, '2026-11-15T00-00-00-000Z_controlled-session.jsonl');
    await writeFile(sessionFile, JSON.stringify({
      type: 'session', version: 3, id: 'controlled-session', timestamp: '2026-11-15T00:00:00.000Z', cwd,
    }) + '\n');
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { review: {
      baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'controlled-placeholder',
      models: [{ id: 'fixture-model', name: 'Fixture Model', input: ['text'], reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 64 }],
    } } }));
    await writeFile(join(capture, 'capture.json'), JSON.stringify({ routes: ['cli-proxy'] }));
    const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, TERM: 'dumb' };
    const args = ['--mode', 'rpc', '--continue', '--provider', 'review', '--model', 'fixture-model',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'];
    const options = { cwd, env, input: '{"id":"state","type":"get_state"}\n', encoding: 'utf8', timeout: 30_000 };
    const direct = spawnSync('pi', args, options);
    assert.equal(direct.status, 0, direct.stderr);
    const state = output => output.trim().split('\n').map(JSON.parse).find(row => row.id === 'state').data;
    assert.equal(state(direct.stdout).sessionFile, sessionFile);
    const wrapped = spawnSync(process.execPath, [resolve('recipes/pi/run.mjs'), ...args], {
      ...options, env: { ...env, PHOENIX_CAPTURE: capture },
    });
    overlay = /Pi private config overlay: (.+)/.exec(wrapped.stderr)?.[1];
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.equal(state(wrapped.stdout).sessionFile, sessionFile,
      'The recipe must continue the same existing session as native Pi, not create a new flat-directory session');
    if (overlay) await rm(overlay, { recursive: true, force: true });
    overlay = undefined;
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: {
      controlled: { command: process.execPath, args: ['--version'], enabled: false },
    } }));
    await writeFile(join(capture, 'capture.json'), JSON.stringify({ routes: ['mcp-proxy', 'cli-proxy'] }));
    const withProject = spawnSync(process.execPath, [resolve('recipes/pi/run.mjs'), ...args], {
      ...options, env: { ...env, PHOENIX_CAPTURE: capture, PHOENIX_CWD: cwd },
    });
    overlay = /Pi private config overlay: (.+)/.exec(withProject.stderr)?.[1];
    assert.equal(withProject.status, 0, withProject.stderr);
    assert.equal(state(withProject.stdout).sessionFile, sessionFile,
      'The project MCP working-directory overlay must not make --continue forget the original project session');
  } finally {
    if (overlay) await rm(overlay, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

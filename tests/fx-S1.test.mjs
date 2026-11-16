import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

test('S1: ACP routes the canonical fx local MCP command and environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-fx-S1-'));
  try {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'fx'), `#!${process.execPath}\nprocess.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
    const config = join(directory, 'mcp.json');
    await writeFile(config, JSON.stringify({ mcp: { scratch: {
      type: 'local', command: [process.execPath, 'scratch-server.mjs'],
      environment: { SCRATCH_MARKER: 'generated-harmless-value' },
    } } }));
    const request = { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: directory, mcpServers: [] } };
    const result = spawnSync(process.execPath, [resolve('recipes/fx/acp.mjs'), '--mcp-config', config], {
      encoding: 'utf8', input: JSON.stringify(request) + '\n',
      env: { ...process.env, HOME: directory, PATH: bin + delimiter + process.env.PATH,
        PHOENIX_FX_MCP_PROXY: 'true', PHOENIX_CAPTURE: join(directory, 'capture') },
      timeout: 10000,
    });
    assert.equal(result.status, 0, `canonical fx MCP config must launch: ${result.stderr}`);
    const forwarded = JSON.parse(result.stdout);
    const server = forwarded.params.mcpServers[0];
    assert.equal(server.command, join(bin, 'phoenix'));
    assert.deepEqual(server.args, ['mcp-proxy', 'scratch', '--', process.execPath, 'scratch-server.mjs']);
    assert.ok(server.env.some(entry => entry.name === 'SCRATCH_MARKER' && entry.value === 'generated-harmless-value'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

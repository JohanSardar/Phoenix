import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S1: a recorded image read reaches the resumed tool with its attachment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-opencode-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const time = 1_794_787_200_000;
  const attachments = [{
    id: 'prt_image', sessionID: 'ses_review', messageID: 'msg_read',
    type: 'file', mime: 'image/png',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0cAAAAASUVORK5CYII=',
  }];
  const session = [
    { opencode_session: 1, info: { id: 'ses_review', directory: '/controlled-project', time: { created: time } } },
    { info: { id: 'msg_user', role: 'user', agent: 'build', time: { created: time }, model: { providerID: 'anthropic', modelID: 'fixture-model' } },
      parts: [{ type: 'text', text: 'Read chart.png and describe it.' }] },
    { info: { id: 'msg_read', role: 'assistant', providerID: 'anthropic', modelID: 'fixture-model', time: { created: time + 1 } },
      parts: [{ type: 'tool', tool: 'read', callID: 'read-chart', state: {
        status: 'completed', input: { filePath: '/controlled-project/chart.png' },
        output: 'Image read successfully', title: 'chart.png', metadata: { truncated: false },
        attachments, time: { start: time + 1, end: time + 2 },
      } }] },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  const made = spawnSync(process.execPath, [resolve('recipes/opencode/moment.mjs'), '--at', '2'],
    { input: session, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const moment = JSON.parse(made.stdout);
  const loadout = join(root, 'loadout.json');
  await writeFile(loadout, JSON.stringify(moment.loadout));
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {}
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 0, result: moment.answers[0].result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['PHOENIX_OPENCODE_LOADOUT', 'PHOENIX_TOOLS_URL', 'PHOENIX_OPENCODE_CONTINUE']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.PHOENIX_OPENCODE_LOADOUT = loadout;
  process.env.PHOENIX_TOOLS_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.PHOENIX_OPENCODE_CONTINUE;
  const { PhoenixStandIn } = await import('../recipes/opencode/stand-in.mjs');
  const plugin = await PhoenixStandIn();
  const result = await plugin.tool.read.execute({ filePath: '/controlled-project/chart.png' },
    { callID: 'resumed-read', abort: new AbortController().signal });
  assert.equal(result.output, 'Image read successfully');
  assert.deepEqual(result.attachments, attachments,
    'The LLM must receive the recorded image, not only the success text');
});

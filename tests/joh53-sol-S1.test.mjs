import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('S1: a recorded Glob succeeds even when its original directory is absent in the box', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh53-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['home', 'config', 'workspace', 'answers']) await mkdir(join(root, dir));
  const binary = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim();
  const originalPath = join(root, 'original-project', 'src');
  const recorded = { filenames: [join(originalPath, 'index.ts')], durationMs: 1, numFiles: 1, truncated: false };
  const calls = [];
  const received = [];
  const server = createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/claude-code') {
      calls.push(body);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
        content: recorded.filenames.join('\n'), is_error: false, toolUseResult: recorded,
      } }));
      return;
    }
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":10}'); return; }
    received.push(body);
    const done = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
    const block = done ? { type: 'text', text: 'Finished.' } : { type: 'tool_use', id: 'toolu_synthetic_glob', name: 'Glob', input: { pattern: '*.ts', path: originalPath } };
    response.setHeader('content-type', 'text/event-stream');
    for (const [type, data] of [
      ['message_start', { message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { index: 0, content_block: { ...block, ...(done ? { text: '' } : { input: {} }) } }],
      ['content_block_delta', { index: 0, delta: done ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }],
      ['message_stop', {}],
    ]) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const hook = phase => [{ matcher: '*', hooks: [{ type: 'command', command: `${process.execPath} ${resolve('recipes/claude-code/stand-in.mjs')} ${phase}` }] }];
  const settings = join(root, 'settings.json');
  await writeFile(settings, JSON.stringify({ hooks: { PreToolUse: hook('pre'), PostToolUse: hook('post') } }));
  const child = spawn(binary, ['-p', 'Find the TypeScript files.', '--settings', settings,
    '--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-4-5',
    '--output-format', 'stream-json', '--verbose'], {
    cwd: join(root, 'workspace'), env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'config'), IS_SANDBOX: '1', CLAUDE_CODE_ENTRYPOINT: 'local-agent',
      ANTHROPIC_API_KEY: 'synthetic-not-a-real-key', ANTHROPIC_BASE_URL: url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      PHOENIX_TOOLS_URL: url, PHOENIX_CC_ANSWERS: join(root, 'answers'),
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, stderr + stdout);
  const toolResult = received.flatMap(body => body.messages).flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result');
  console.log(JSON.stringify({ phoenix_calls: calls.length, toolResult }));
  assert.equal(calls.length, 1, 'The real PreToolUse hook must receive the recorded answer');
  assert.ok(toolResult, stdout);
  assert.notEqual(toolResult.is_error, true, 'The session has a successful recorded Glob result, so replay must not turn it into a missing-directory error');
  assert.ok(JSON.stringify(toolResult.content).includes(recorded.filenames[0]));
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeMomentBundle } from '../packages/store/src/index.ts';
import { approveCheck, reviewDraft } from '../packages/approvals/src/index.ts';

export async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-t17-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function cli(command, args, input = '') {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(`packages/cli/src/${command}.ts`), ...args], {
      env: { ...process.env, PHOENIX_SETUP_MODEL_HEADERS: '{}' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', status => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function event(seq, kind, extra = {}, value) {
  return {
    v: 1, capture: 'review', stream: 'session', seq, id: `event-${seq}`,
    ts: { wall: new Date(Date.UTC(2026, 10, 15, 0, 0, seq)).toISOString() },
    kind, verbatim: ['body.inline'], ...extra,
    ...(value === undefined ? {} : { body: { inline: typeof value === 'string' ? value : JSON.stringify(value) } }),
  };
}

export function catalog(tools = []) {
  const mcp = { surface: 'mcp', layer: 'agent', connector: 'calendar' };
  return [
    event(1, 'call', { ...mcp, op: 'initialize' }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    event(2, 'result', { ...mcp, op: 'initialize' }, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'calendar', version: '1' } } }),
    event(3, 'call', { ...mcp, op: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    event(4, 'result', { ...mcp, op: 'tools/list' }, { jsonrpc: '2.0', id: 2, result: { tools } }),
  ];
}

export async function record(root, events) {
  const coverage = event(0, 'meta', { stream: 'coverage', op: 'transcript.coverage' }, {
    harness_versions: ['1'], carries: ['tool-use', 'tool-result'], lacks: ['wire'],
  });
  const result = await cli('record', ['--home', join(root, 'record-home')], [coverage, ...events].map(e => JSON.stringify(e) + '\n').join(''));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).capture;
}

export async function draft(root, events, manifest = {}, files = new Map()) {
  const path = join(root, 'private');
  await writeMomentBundle(path, {
    manifest: { phoenix_moment: 1, id: 'review', source: 'snapshot', run: { capture: 'review', task: '' }, mark: events.at(-1)?.id ?? 'event-1', ...manifest },
    files: new Map([
      ['data/run.jsonl', events.map(e => JSON.stringify(e) + '\n').join('')],
      ['check.draft.yaml', JSON.stringify({ phoenix_check: 1, samples: { base: 2, tiebreak: 1 }, scope: 'continuation', intent: 'Repair the run.' })],
      ...files,
    ]),
  });
  return path;
}

export async function approve(root, path) {
  await approveCheck(path, { home: join(root, 'home'), who: 'reviewer', reviewed: (await reviewDraft(path)).digest });
}

export async function model(t, reply) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const value = typeof reply === 'function' ? reply(request) : reply;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  t.after(() => new Promise(resolveClosed => { server.closeAllConnections(); server.close(resolveClosed); }));
  return ['--model', 'review-fixture', '--model-endpoint', `http://127.0.0.1:${server.address().port}/v1/responses`];
}

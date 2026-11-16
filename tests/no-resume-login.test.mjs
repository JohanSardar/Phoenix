import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

test('a refused Codex response stream must fail login before the harness starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-no-resume-login-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: response.failed\ndata: ' + JSON.stringify({
      type: 'response.failed', sequence_number: 0,
      response: { id: 'review-refused', object: 'response', status: 'failed', output: [],
        error: { code: 'rate_limit_exceeded', message: 'Usage limit reached' } },
    }) + '\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const redirect = join(root, 'redirect.mjs');
  await writeFile(redirect, `const fetchUpstream = globalThis.fetch;
globalThis.fetch = (url, options) => fetchUpstream(process.env.REVIEW_UPSTREAM, options);
`);
  const auth = join(root, 'pi');
  await mkdir(auth);
  await writeFile(join(auth, 'auth.json'), JSON.stringify({ 'openai-codex': {
    type: 'oauth', access: 'controlled-review-access', accountId: 'review-account',
    expires: Date.now() + 60 * 60 * 1000,
  } }));
  const results = [];
  for (const recipe of ['mini-swe-agent', 'openai-cs-agents-demo']) {
    const box = join(root, recipe);
    await mkdir(join(box, 'agent'), { recursive: true });
    await mkdir(join(box, 'moment'));
    await writeFile(join(box, 'moment/moment.json'), JSON.stringify({ model: { id: 'gpt-6.1-terra' } }));
    const run = await promisify(execFile)(process.execPath, ['--import', redirect,
      resolve('recipes', recipe, 'login.mjs'), join(box, 'agent'), 'openai-codex'], {
      env: { ...process.env, PI_CODING_AGENT_DIR: auth,
        REVIEW_UPSTREAM: `http://127.0.0.1:${server.address().port}/responses` },
      timeout: 10_000,
    }).then(value => ({ code: 0, ...value }), error => ({ code: error.code, stderr: error.stderr }));
    results.push({ recipe, code: run.code, reason: /usage limit reached/i.test(run.stderr),
      loginWritten: await access(join(box, 'agent/llm.json')).then(() => true, () => false) });
  }
  assert.deepEqual(results, ['mini-swe-agent', 'openai-cs-agents-demo'].map(recipe => ({
    recipe, code: 1, reason: true, loginWritten: false,
  })), 'A failed stream is a refusal, not a successful login that may start a failing replay');
});

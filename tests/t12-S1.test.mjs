import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { submitTask } from '../packages/runner/src/server.ts';

test('S1: a server harness receives quoted multiline task text intact', async t => {
  let received;
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end('ready'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    try { received = JSON.parse(body); res.end('done'); }
    catch { received = { malformed: body }; res.writeHead(400).end('invalid JSON'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const prompt = 'Move the "3pm" meeting.\nTell its attendees.';
  const outcome = await submitTask({ connect: port => connect({ host: '127.0.0.1', port }) }, {
    serve: ['node', 'server.mjs'],
    ready: { http: `GET http://localhost:${server.address().port}/health` },
    submit: { http: { method: 'POST', path: '/tasks', body: '{"task":"{task}"}' } },
  }, prompt);
  assert.deepEqual({ outcome, received }, { outcome: { kind: 'finished', code: 0 }, received: { task: prompt } });
});
